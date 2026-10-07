/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent, Usage } from "@workglow/task-graph";
import type { PartialJsonStream } from "@workglow/util/worker";
import { createPartialJsonStream, parsePartialJson } from "@workglow/util/worker";
import type { ToolCallingTaskOutput } from "../task/ToolCallingTask";
import type { ToolCalls, ToolDefinition } from "../task/ToolCallingUtils";
import { buildToolDescription, sanitizeToolArgs } from "../task/ToolCallingUtils";
import { createEstimatedOutputUsageReporter, mapOpenAIChatUsage } from "./UsageMapping";

/**
 * Shared helpers for providers that expose an OpenAI-compatible chat-completions
 * API (currently OpenAI itself and Hugging Face Inference). They cover:
 *
 *  - Building the OpenAI `tools` array from workglow {@link ToolDefinition}s.
 *  - Mapping workglow `toolChoice` strings to the OpenAI union, with optional
 *    named-function support (HFI accepts only `auto | none | required`).
 *  - Streaming a chat-completions response into workglow {@link StreamEvent}s,
 *    accumulating fragmented tool-call argument JSON internally and yielding
 *    `text-delta` + per-tool-call `object-delta` events. The final `finish`
 *    event carries `{}` per the streaming convention in CLAUDE.md — the
 *    consumer (`StreamProcessor`) is responsible for accumulating deltas.
 */

/** OpenAI-shape tool entry. Kept loose because each SDK names the type differently. */
export interface OpenAIShapedTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;

    readonly parameters: any;
  };
}

export type OpenAIShapedToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

export function buildOpenAITools(tools: readonly ToolDefinition[]): OpenAIShapedTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: buildToolDescription(t),

      parameters: t.inputSchema as any,
    },
  }));
}

/**
 * Map workglow `toolChoice` to an OpenAI-shaped tool_choice value.
 *
 * @param toolChoice - One of `"auto" | "none" | "required" | <tool_name>` (or undefined).
 * @param allowNamedFunction - When true, an unrecognized value is treated as a
 *   tool name and emitted as `{ type: "function", function: { name } }`. When
 *   false (HFI), it falls back to `"auto"` because HFI's API only accepts the
 *   three keywords.
 */
export function mapOpenAIToolChoice(
  toolChoice: string | undefined,
  allowNamedFunction: boolean
): OpenAIShapedToolChoice {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (allowNamedFunction) return { type: "function", function: { name: toolChoice } };
  return "auto";
}

/** Best-effort JSON parse: full parse first, then partial-JSON fallback, then `{}`. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const partial = parsePartialJson(raw);
    return partial && typeof partial === "object" ? (partial as Record<string, unknown>) : {};
  }
}

/**
 * Parse a non-streaming OpenAI-shape chat completion message into workglow
 * {@link ToolCalls}. Used by the synchronous `*_ToolCalling` runFns.
 *
 * Some providers (HFI) don't always return an `id` per tool call; we
 * auto-generate `call_<index>` in that case.
 */
export function parseOpenAIToolCallMessage(toolCallsRaw: readonly any[] | undefined): ToolCalls {
  const result: ToolCalls = [];
  if (!toolCallsRaw) return result;
  let idx = 0;
  for (const tc of toolCallsRaw) {
    if (!tc || !tc.function) {
      idx++;
      continue;
    }
    const id = (tc.id as string | undefined) ?? `call_${idx}`;
    const name = tc.function.name as string;
    const rawArgs = tc.function.arguments;
    const parsed =
      typeof rawArgs === "string"
        ? parseToolArgs(rawArgs)
        : rawArgs && typeof rawArgs === "object"
          ? (rawArgs as Record<string, unknown>)
          : {};
    const input = sanitizeToolArgs(parsed) as Record<string, unknown>;
    result.push({ id, name, input });
    idx++;
  }
  return result;
}

/**
 * Per-tool-call streaming state. `args` is fed each argument fragment as it
 * arrives, so a delta costs O(fragment) rather than re-parsing the call's whole
 * accumulated argument string; `parsed` caches the parser's live root so a
 * delta carrying only an id or a name still emits the arguments seen so far.
 */
interface ToolCallAccumulatorEntry {
  id: string;
  name: string;
  readonly args: PartialJsonStream;
  parsed: Record<string, unknown>;
}

/**
 * Adapt an OpenAI-shape streaming response (each chunk has
 * `choices[0].delta.{content?, tool_calls?[]}`) to workglow stream events.
 * Forwards events via the `emit` callback:
 *  - `text-delta` for each non-empty `delta.content`.
 *  - `object-delta` (single-element array) per tool-call delta with the latest
 *    parsed input. The downstream `StreamProcessor` upserts by `id`.
 *
 * The caller is responsible for emitting its own `finish` event after this
 * returns — most callers will use structural defaults like
 * `{ text: "", toolCalls: [] }` so the final output satisfies
 * {@link ToolCallingTaskOutput} even when the model streams only
 * `tool_calls` (no `content` deltas).
 *
 * Returns the stream's token accounting when the request opted in with
 * `stream_options: { include_usage: true }`, else `undefined`. That usage
 * arrives on a final chunk with an **empty** `choices` array, so it is read
 * before the choice-less chunk is skipped. The caller attaches it to its
 * `finish` event as a sibling of `data`.
 *
 * `mapUsage` defaults to the standard OpenAI-shape mapping; a provider that
 * reports counters beyond that common set (DeepSeek's cache hit/miss split,
 * OpenRouter's `cost`) passes its own mapper instead.
 *
 * Pass `promptText` to emit a provisional ↑ estimate before the first delta —
 * chat-completions only attach billed usage to the terminal chunk.
 */
export async function accumulateOpenAIChatStream(
  stream: AsyncIterable<any>,
  emit: (event: StreamEvent<ToolCallingTaskOutput>) => void,
  mapUsage: (raw: unknown) => Usage | undefined = mapOpenAIChatUsage,
  options: { readonly promptText?: string | undefined } = {}
): Promise<Usage | undefined> {
  const toolCallAccumulator = new Map<number, ToolCallAccumulatorEntry>();
  // Chat-completions shape only reports billed usage on the final empty-choices
  // chunk; when the caller supplies promptText, estimate ↑ before the first
  // delta and ↓ from content / tool-arg deltas so the CLI counter moves during
  // the call. The caller still attaches the provider total to `finish.usage`.
  const provisionalUsage =
    options.promptText !== undefined ? createEstimatedOutputUsageReporter(emit) : undefined;
  if (provisionalUsage && options.promptText !== undefined) {
    provisionalUsage.onPrompt(options.promptText);
  }
  let usage: Usage | undefined;

  for await (const chunk of stream) {
    usage = mapUsage(chunk?.usage) ?? usage;

    const choice = chunk?.choices?.[0];
    if (!choice) continue;

    // Thinking models on OpenAI-compatible APIs stream their reasoning beside
    // the content: DeepSeek as `reasoning_content`, OpenRouter as `reasoning`.
    const reasoningDelta: unknown = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
      provisionalUsage?.onText(reasoningDelta);
      emit({ type: "text-delta", port: "reasoning", textDelta: reasoningDelta });
    }

    const contentDelta: string = choice.delta?.content ?? "";
    if (contentDelta) {
      provisionalUsage?.onText(contentDelta);
      emit({ type: "text-delta", port: "text", textDelta: contentDelta });
    }

    // OpenAI-compatible chat completions surface safety refusals as a `refusal`
    // string on the delta (distinct from `content`). Emit it as a first-class
    // refusal event so it lands in the reserved `refusal` output field.
    const refusalDelta: string = choice.delta?.refusal ?? "";
    if (refusalDelta) {
      emit({ type: "refusal", refusal: refusalDelta });
    }

    const tcDeltas = choice.delta?.tool_calls;
    if (!Array.isArray(tcDeltas)) continue;

    for (const tcDelta of tcDeltas) {
      const idx: number = tcDelta.index ?? 0;
      let acc = toolCallAccumulator.get(idx);
      if (!acc) {
        acc = {
          id: tcDelta.id ?? "",
          name: tcDelta.function?.name ?? "",
          args: createPartialJsonStream(),
          parsed: {},
        };
        toolCallAccumulator.set(idx, acc);
      }
      if (tcDelta.id) acc.id = tcDelta.id;
      if (tcDelta.function?.name) acc.name = tcDelta.function.name;
      if (tcDelta.function?.arguments) {
        acc.parsed = acc.args.push(tcDelta.function.arguments) ?? acc.parsed;
      }

      // Synthesise a stable id when the provider doesn't emit one, matching
      // the non-streaming `parseOpenAIToolCallMessage` fallback. Without this,
      // multiple tool calls with empty ids would collide under the
      // StreamProcessor's id-based upsert.
      const stableId = acc.id || `call_${idx}`;

      // `sanitizeToolArgs` copies, so the emitted delta is detached from the
      // parser's live root and unaffected by later fragments.
      const sanitizedInput = sanitizeToolArgs(acc.parsed) as Record<string, unknown>;
      // Argument JSON is also generated text — count it so a tools-only reply
      // still ticks the ↓ counter (content deltas alone would stay silent).
      if (tcDelta.function?.arguments) {
        provisionalUsage?.onText(tcDelta.function.arguments);
      }
      emit({
        type: "object-delta",
        port: "toolCalls",
        objectDelta: [{ id: stableId, name: acc.name, input: sanitizedInput }],
      });
    }
  }

  provisionalUsage?.flush();
  return usage;
}
