/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ChatMessage,
  ToolCall,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolDefinition,
} from "@workglow/ai";
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { filterValidToolCalls, sanitizeToolArgs } from "@workglow/ai/worker";
import type { PartialJsonStream } from "@workglow/util/worker";
import { createPartialJsonStream, getLogger } from "@workglow/util/worker";
import {
  annotateLastBlock,
  annotateLastTool,
  applyAnthropicPrefixReplay,
  toAnthropicTools,
  wrapSystemWithCacheControl,
} from "./Anthropic_CacheCheckpoint";
import { getClient, getMaxTokens, getModelName } from "./Anthropic_Client";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import { maybeEmitAnthropicRefusal } from "./Anthropic_Refusal";
import {
  anthropicAcceptsForcedToolChoice,
  applyAnthropicSamplingParams,
} from "./Anthropic_RequestParams";
import { applyAnthropicThinkingParams } from "./Anthropic_Thinking";
import { createAnthropicUsageCollector } from "./Anthropic_Usage";

/**
 * Anthropic rejects empty text blocks and empty content arrays on non-final
 * messages, and hand-built or previously recorded checkpoint prefixes may
 * still carry them: drop empty text blocks while converting, and skip any
 * message whose content ends up empty.
 */
function isEmptyTextBlock(block: { type?: unknown; text?: unknown }): boolean {
  return block.type === "text" && (block.text === undefined || block.text === "");
}

/**
 * The turn a model produced, as the blocks the API returned in the order it
 * returned them — or `undefined` when the payload is unusable or the host
 * changed the turn's tool calls, in which case it is rebuilt from the message.
 */
function parseOwnTurn(payload: string, content: ChatMessage["content"]): any[] | undefined {
  let blocks: unknown;
  try {
    blocks = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(blocks)) return undefined;
  const sentIds = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b) => (b as { id?: unknown }).id);
  const messageIds = content.filter((b) => b.type === "tool_use").map((b) => b.id);
  if (sentIds.length !== messageIds.length) return undefined;
  if (sentIds.some((id, i) => id !== messageIds[i])) return undefined;
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * `nativeTurnProvider` is the key a reasoning block must carry to be replayed;
 * without it every assistant turn is rebuilt from its text and tool calls.
 */
export function buildAnthropicMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: unknown,
  nativeTurnProvider?: string
): any[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const blocks = msg.content
        .filter((b) => b.type !== "reasoning")
        .map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") {
            return {
              type: "image",
              source: { type: "base64", media_type: b.mimeType, data: b.data },
            };
          }
          return b;
        })
        .filter((b) => !isEmptyTextBlock(b));
      if (blocks.length === 0) continue;
      out.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      // The model's own turn, replayed exactly as it produced it: a thinking
      // block's signature binds it to the conversation before it, so its text,
      // the tool inputs and the block order are sent unchanged — and only while
      // the calls still match, since a host that renamed one changed the turn.
      const own =
        nativeTurnProvider === undefined
          ? undefined
          : msg.content.find(
              (b): b is Extract<ChatMessage["content"][number], { type: "reasoning" }> =>
                b.type === "reasoning" &&
                b.provider === nativeTurnProvider &&
                b.payload !== undefined
            );
      const replayed = own ? parseOwnTurn(own.payload!, msg.content) : undefined;
      if (replayed) {
        out.push({ role: "assistant", content: replayed });
        continue;
      }
      // Reasoning another provider streamed as text has no Anthropic form (its
      // thinking blocks are signed), and an unknown block is a 400.
      const blocks = msg.content
        .filter((b) => b.type !== "reasoning")
        .map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "tool_use") {
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          }
          return b;
        })
        .filter((b) => !isEmptyTextBlock(b));
      if (blocks.length === 0) continue;
      out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      const blocks = msg.content
        .filter(
          (b): b is Extract<ChatMessage["content"][number], { type: "tool_result" }> =>
            b.type === "tool_result"
        )
        .map((b) => {
          const content = b.content.map((inner) => {
            if (inner.type === "text") return { type: "text", text: inner.text };
            if (inner.type === "image") {
              return {
                type: "image",
                source: { type: "base64", media_type: inner.mimeType, data: inner.data },
              };
            }
            return inner;
          });
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            content,
            ...(b.is_error ? { is_error: true } : {}),
          };
        });
      if (blocks.length === 0) continue;
      out.push({ role: "user", content: blocks });
    } else if (msg.role === "system") {
      // System prompts are handled separately via params.system; skip here.
      continue;
    }
  }
  return out;
}

/**
 * Per content-block streaming state. A tool-use block owns an incremental JSON
 * parser that is fed one `input_json_delta` at a time, so each delta costs
 * O(delta) rather than re-parsing the whole accumulated argument buffer.
 */
type AnthropicBlockMeta =
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly json: PartialJsonStream;
    }
  | { readonly type: "text" };

/** A content block as the API produced it, accumulated for replay. */
type NativeBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; raw: string };

const THINKING_BLOCK_TYPES: ReadonlySet<string> = new Set(["thinking", "redacted_thinking"]);

/** Anthropic's 400 for a replayed thinking block whose signature no longer matches. */
function isThinkingSignatureError(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | undefined;
  return (
    e?.status === 400 &&
    typeof e.message === "string" &&
    e.message.includes("Invalid `signature` in `thinking` block")
  );
}

/** The messages with every thinking block removed; a message left empty is dropped. */
function withoutThinking(messages: readonly any[]): any[] {
  const out: any[] = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const content = msg.content.filter((b: any) => !THINKING_BLOCK_TYPES.has(b?.type));
    if (content.length > 0) out.push({ ...msg, content });
  }
  return out;
}

/**
 * The reply's blocks in index order as the API produced them, or `undefined`
 * when there is nothing to replay or a tool input cannot be parsed from its raw
 * JSON (the replay must carry exactly what the model wrote, so a guess is worse
 * than rebuilding the turn).
 */
function serializeNativeTurn(native: ReadonlyMap<number, NativeBlock>): string | undefined {
  const blocks: unknown[] = [];
  for (const [, block] of [...native.entries()].sort((a, b) => a[0] - b[0])) {
    if (block.type === "tool_use") {
      let input: unknown;
      try {
        input = block.raw ? JSON.parse(block.raw) : {};
      } catch {
        return undefined;
      }
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input });
    } else if (block.type === "text") {
      // The API rejects an empty text block, so one is never part of a turn to replay.
      if (block.text !== "") blocks.push(block);
    } else {
      blocks.push(block);
    }
  }
  return blocks.length > 0 ? JSON.stringify(blocks) : undefined;
}

function mapAnthropicToolChoice(
  toolChoice: string | undefined
): { type: "auto" } | { type: "any" } | { type: "tool"; name: string } | undefined {
  if (!toolChoice || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return undefined;
  if (toolChoice === "required") return { type: "any" };
  return { type: "tool", name: toolChoice };
}

export const Anthropic_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  AnthropicModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const sessionId = sessionContext?.sessionId;
  const client = await getClient(model);
  const modelName = getModelName(model);

  // The caller's tools win; a checkpoint consumer whose (schema-required)
  // tools list is empty falls back to the prefix's, so replayed tool_use
  // blocks stay declared and the request shares the warm-up's cached tool
  // segment.
  const toolDefinitions: readonly ToolDefinition[] =
    input.tools.length > 0 ? input.tools : (sessionContext?.prefix?.tools ?? input.tools);
  const tools = toAnthropicTools(toolDefinitions);

  let toolChoice = mapAnthropicToolChoice(input.toolChoice);
  if (
    (toolChoice?.type === "any" || toolChoice?.type === "tool") &&
    !anthropicAcceptsForcedToolChoice(model)
  ) {
    getLogger().warn("Anthropic model rejects a forced tool choice; sending auto instead.", {
      model: modelName,
      tool_choice: input.toolChoice,
    });
    toolChoice = { type: "auto" };
  }

  // Thinking blocks are bound to the model that produced them, so the native
  // turn is keyed by model and another model gets the rebuilt turn.
  const nativeKey = `anthropic:${modelName}`;
  const messages = buildAnthropicMessages(input.messages, input.prompt, nativeKey);

  const params: any = {
    model: modelName,
    messages,
    max_tokens: getMaxTokens(input, model),
  };

  // tool_choice first: a forced choice suppresses legacy extended thinking,
  // which in turn decides whether sampling parameters are legal.
  if (toolChoice !== undefined) {
    params.tools = tools;
    params.tool_choice = toolChoice;
  }

  applyAnthropicThinkingParams(params, model);
  applyAnthropicSamplingParams(params, input, model);

  if (input.systemPrompt) {
    params.system = input.systemPrompt;
  }

  // Emit-only run (emitCheckpoint with no parent checkpoint): this request is
  // the cache write the emitted checkpoint's first consumer reads, so it needs
  // the plain-session-style breakpoints even without a sessionId.
  const emitBoundary =
    sessionContext?.emitCheckpointId !== undefined && sessionContext?.prefix === undefined;

  if (sessionContext?.prefix) {
    if (typeof params.system === "string") {
      params.system = wrapSystemWithCacheControl(params.system);
    }
    applyAnthropicPrefixReplay(params, sessionContext);
    if (Array.isArray(params.tools)) {
      annotateLastTool(params.tools);
    }
  } else if (sessionId || emitBoundary) {
    // Plain session or emit-only run: breakpoints on system + last tool. An
    // emit-only run also marks the final message so the emitted turn itself
    // lands in the cache (a string prompt tail is lifted by annotateLastBlock).
    if (typeof params.system === "string") {
      params.system = wrapSystemWithCacheControl(params.system);
    }
    if (Array.isArray(params.tools)) {
      annotateLastTool(params.tools);
    }
    if (emitBoundary && Array.isArray(params.messages) && params.messages.length > 0) {
      annotateLastBlock(params.messages[params.messages.length - 1]);
    }
  }

  /**
   * One request and the consumption of its stream. All streaming state lives
   * inside, so a retry starts clean; `emitted` records whether anything has
   * reached the consumer, since a retry after output would repeat it.
   */
  let emitted = false;
  const emitTracked: typeof emit = (event) => {
    emitted = true;
    emit(event);
  };

  const consume = async (requestParams: any): Promise<void> => {
    const stream = client.messages.stream(requestParams, { signal });

    const blockMeta = new Map<number, AnthropicBlockMeta>();
    const native = new Map<number, NativeBlock>();
    /** Keyed by Anthropic content block index — avoids collisions when `id` is missing during early deltas. */
    const toolCallsByBlockIndex = new Map<number, ToolCall>();

    const toolCallsInStreamOrder = (): ToolCall[] =>
      [...toolCallsByBlockIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);

    /**
     * Defence-in-depth: drop tool calls whose name isn't in the effective
     * declared tool set (the caller's tools, or the prefix's on fallback)
     * before yielding to the consumer. Anthropic's tool API normally respects
     * the declarations, but a stray response from a model that hallucinates a
     * function name would otherwise propagate to dispatch.
     */
    const validatedToolCallsInStreamOrder = (): ToolCall[] =>
      filterValidToolCalls(toolCallsInStreamOrder(), toolDefinitions);

    const usageCollector = createAnthropicUsageCollector();
    const snapshotUsage = createUsageSnapshotEmitter(emitTracked);
    for await (const event of stream) {
      usageCollector.observe(event);
      snapshotUsage(usageCollector.result());
      maybeEmitAnthropicRefusal(event, emitTracked);
      if (event.type === "content_block_start") {
        const block = event.content_block;
        const index = event.index as number;
        if (block.type === "tool_use") {
          blockMeta.set(index, {
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "",
            json: createPartialJsonStream(),
          });
          native.set(index, {
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "",
            raw: "",
          });
        } else if (block.type === "text") {
          blockMeta.set(index, { type: "text" });
          native.set(index, { type: "text", text: "" });
        } else if (block.type === "thinking") {
          native.set(index, {
            type: "thinking",
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          });
        } else if (block.type === "redacted_thinking") {
          native.set(index, { type: "redacted_thinking", data: block.data ?? "" });
        }
      } else if (event.type === "content_block_delta") {
        const index = event.index as number;
        const delta = event.delta as any;
        const nativeBlock = native.get(index);
        if (delta.type === "text_delta") {
          if (nativeBlock?.type === "text") nativeBlock.text += delta.text ?? "";
          emitTracked({ type: "text-delta", port: "text", textDelta: delta.text });
        } else if (delta.type === "thinking_delta") {
          if (nativeBlock?.type === "thinking") nativeBlock.thinking += delta.thinking ?? "";
        } else if (delta.type === "signature_delta") {
          if (nativeBlock?.type === "thinking") nativeBlock.signature += delta.signature ?? "";
        } else if (delta.type === "input_json_delta") {
          if (nativeBlock?.type === "tool_use") nativeBlock.raw += delta.partial_json ?? "";
          const meta = blockMeta.get(index);
          if (meta?.type === "tool_use") {
            // `push` returns the parser's live root; `sanitizeToolArgs` copies it,
            // so the emitted call is detached from later mutations.
            const parsedInput = meta.json.push(delta.partial_json ?? "") ?? {};
            toolCallsByBlockIndex.set(index, {
              id: meta.id,
              name: meta.name,
              input: sanitizeToolArgs(parsedInput) as Record<string, unknown>,
            });
            emitTracked({
              type: "object-delta",
              port: "toolCalls",
              objectDelta: validatedToolCallsInStreamOrder(),
            });
          }
        }
      } else if (event.type === "content_block_stop") {
        const index = event.index as number;
        const meta = blockMeta.get(index);
        if (meta?.type === "tool_use") {
          const finalInput = meta.json.finishObject();
          toolCallsByBlockIndex.set(index, {
            id: meta.id,
            name: meta.name,
            input: sanitizeToolArgs(finalInput) as Record<string, unknown>,
          });
          emitTracked({
            type: "object-delta",
            port: "toolCalls",
            objectDelta: validatedToolCallsInStreamOrder(),
          });
        }
        blockMeta.delete(index);
      }
    }

    const nativeTurn = serializeNativeTurn(native);
    if (nativeTurn !== undefined) {
      emitTracked({
        type: "object-delta",
        port: "nativeTurn",
        objectDelta: { provider: nativeKey, payload: nativeTurn },
      });
    }

    emitTracked({
      type: "finish",
      data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
      usage: usageCollector.result(),
    });
  };

  try {
    await consume(params);
  } catch (err) {
    // A replayed thinking block whose signature no longer matches is a 400
    // decided before any output; the documented recovery is to send the turn
    // without its thinking, once.
    const stripped = isThinkingSignatureError(err) ? withoutThinking(params.messages) : undefined;
    if (emitted || stripped === undefined || !Array.isArray(params.messages)) throw err;
    getLogger().warn("Anthropic rejected replayed thinking; retrying without it.", {
      model: modelName,
    });
    await consume({ ...params, messages: stripped });
  }
};
