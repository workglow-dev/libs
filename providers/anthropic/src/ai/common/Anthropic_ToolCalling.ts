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

export function buildAnthropicMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: unknown
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

  const messages = buildAnthropicMessages(input.messages, input.prompt);

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

  const stream = client.messages.stream(params, { signal });

  const blockMeta = new Map<number, AnthropicBlockMeta>();
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
  const snapshotUsage = createUsageSnapshotEmitter(emit);
  for await (const event of stream) {
    usageCollector.observe(event);
    snapshotUsage(usageCollector.result());
    maybeEmitAnthropicRefusal(event, emit);
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
      } else if (block.type === "text") {
        blockMeta.set(index, { type: "text" });
      }
    } else if (event.type === "content_block_delta") {
      const index = event.index as number;
      const delta = event.delta as any;
      if (delta.type === "text_delta") {
        emit({ type: "text-delta", port: "text", textDelta: delta.text });
      } else if (delta.type === "input_json_delta") {
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
          emit({
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
        emit({
          type: "object-delta",
          port: "toolCalls",
          objectDelta: validatedToolCallsInStreamOrder(),
        });
      }
      blockMeta.delete(index);
    }
  }

  emit({
    type: "finish",
    data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
    usage: usageCollector.result(),
  });
};
