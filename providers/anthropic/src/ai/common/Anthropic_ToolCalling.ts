/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
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
import type { NativeBlock } from "./Anthropic_NativeTurn";
import {
  buildAnthropicMessages,
  omitThinkingUnlessReplayAllowed,
  sendWithThinkingRetry,
  serializeNativeTurn,
} from "./Anthropic_NativeTurn";
import { maybeEmitAnthropicRefusal } from "./Anthropic_Refusal";
import {
  anthropicAcceptsForcedToolChoice,
  applyAnthropicSamplingParams,
} from "./Anthropic_RequestParams";
import { applyAnthropicThinkingParams } from "./Anthropic_Thinking";
import { createAnthropicUsageCollector } from "./Anthropic_Usage";

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

  // A request that runs without thinking cannot carry signed thinking blocks:
  // the history may hold them from an earlier round of this same model that
  // ran with thinking (an auto-choice round, before a forced choice suppressed
  // legacy extended thinking, or before the setting changed), and the
  // checkpoint prefix may too. Sending them is a 400 the signature retry below
  // does not handle, so they go before the request.
  omitThinkingUnlessReplayAllowed(params);

  /** Whether anything has reached the consumer, since a retry after output would repeat it. */
  let emitted = false;
  const emitTracked: typeof emit = (event) => {
    emitted = true;
    emit(event);
  };

  /**
   * One request and the consumption of its stream. All streaming state lives
   * inside, so a retry starts clean.
   */
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

    /** Cleared by any block or delta the replay cannot reproduce exactly. */
    let verbatim = true;

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
        } else {
          verbatim = false;
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
          if (delta.thinking) {
            emitTracked({ type: "text-delta", port: "reasoning", textDelta: delta.thinking });
          }
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
        } else {
          verbatim = false;
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

    const nativeTurn = verbatim ? serializeNativeTurn(native) : undefined;
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

  // A replayed thinking block whose signature no longer matches is a 400
  // decided before any output; the documented recovery is to send the turn
  // without its thinking, once.
  await sendWithThinkingRetry(params, consume, () => emitted, modelName);
};
