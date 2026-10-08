/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { StreamEvent, Usage } from "@workglow/task-graph";
import type { ToolCalls, ToolDefinition } from "../task/ToolCallingUtils";
import { buildToolDescription, sanitizeToolArgs } from "../task/ToolCallingUtils";
import { parseToolArgs } from "./OpenAIShapedChat";
import { createEstimatedOutputUsageReporter, mapOpenAIResponsesUsage } from "./UsageMapping";

/**
 * Shared helpers for the OpenAI **Responses** API (`client.responses.create`),
 * the sibling of {@link file://./OpenAIShapedChat.ts} for the Chat Completions
 * API. Only the OpenAI provider uses Responses today (Hugging Face Inference and
 * other OpenAI-compatible providers stay on Chat Completions), but these live
 * next to the chat helpers because they are the same "OpenAI shape" family.
 *
 * They cover:
 *  - Building the Responses `input` + `instructions` from workglow messages.
 *  - Building the Responses `tools` array (flatter than the chat shape) and
 *    mapping workglow `toolChoice`.
 *  - Streaming a Responses event stream into workglow {@link StreamEvent}s.
 *    Responses emits *typed* events (`response.output_text.delta`,
 *    `response.function_call_arguments.delta`, …) rather than raw chat chunks;
 *    the accumulator maps them to `text-delta` + per-tool-call `object-delta`
 *    events. The final `finish` event is the caller's responsibility, per the
 *    streaming convention in CLAUDE.md.
 */

/**
 * Chat-shaped message as produced by `toOpenAIMessages`. Content is either a
 * string, a parts array (`text` / `image_url`), or null; assistant messages may
 * carry `tool_calls`; tool-result messages carry `tool_call_id`.
 */
export interface OpenAIResponsesMessageSource {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: readonly {
    readonly id?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
  readonly tool_call_id?: string;
  /** The provider's own output items for this assistant turn, replayed verbatim. */
  readonly native_items?: readonly unknown[] | undefined;
}

/** A Responses request `input` item — a role message or a tool item. */
export type OpenAIResponsesInputItem = Record<string, unknown>;

export interface OpenAIResponsesInput {
  readonly input: string | OpenAIResponsesInputItem[];
  readonly instructions: string | undefined;
}

/** Map a chat-shaped content parts array to Responses input content parts. */
function mapContentParts(content: readonly any[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of content) {
    if (block?.type === "text") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block?.type === "image_url") {
      // Responses `input_image.image_url` is the URL string itself, not the
      // chat-shape `{ url }` object.
      const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
      parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts;
}

/** Coerce a message's content into a plain string (for tool-result output). */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === "text" ? b.text : typeof b === "string" ? b : ""))
      .join("");
  }
  return asText(content);
}

/** Responses-shape function tool. Flatter than the chat `{function:{…}}` nesting. */
export interface OpenAIResponsesTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;

  readonly parameters: any;
  readonly strict: boolean;
}

export type OpenAIResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly name: string };

/**
 * Build the Responses `input` + `instructions` from the unified text-generation
 * input shape. System/developer messages are lifted into `instructions` (the
 * Responses idiom for a system prompt); the remaining messages become `input`
 * items. When only a `prompt` string is supplied, `input` is that string.
 *
 * Message content is passed through as-is: string content maps 1:1 onto a
 * Responses `EasyInputMessage`. Non-string (multimodal) content is left to the
 * caller/provider to have already shaped correctly.
 */
export function buildResponsesInput(args: {
  readonly messages?: readonly OpenAIResponsesMessageSource[] | undefined;
  readonly prompt?: string | undefined;
  readonly systemPrompt?: string | undefined;
}): OpenAIResponsesInput {
  const instructionParts: string[] = [];
  if (args.systemPrompt) instructionParts.push(args.systemPrompt);

  const hasMessages = Array.isArray(args.messages) && args.messages.length > 0;
  if (!hasMessages) {
    return {
      input: args.prompt ?? "",
      instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
    };
  }

  const items: OpenAIResponsesInputItem[] = [];
  for (const message of args.messages as readonly OpenAIResponsesMessageSource[]) {
    // Lift leading system/developer prompts into `instructions`; keep them out
    // of `input` so the Responses request uses the canonical system channel.
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") instructionParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      // Chat `{ role: "tool", tool_call_id, content }` -> Responses
      // `function_call_output` item.
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: contentToString(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      // The provider's own turn, replayed as it produced it: its reasoning only
      // continues from items it can decrypt, and only while the calls still
      // match — a host that renamed or dropped a call gets the rebuilt turn.
      const native = message.native_items;
      if (native && sameCallIds(native, message.tool_calls ?? [])) {
        items.push(...(native as OpenAIResponsesInputItem[]));
        continue;
      }
      // Preserve any assistant text, then each tool call as a `function_call`
      // item (Responses represents tool calls as items, not message fields).
      const text = contentToString(message.content);
      if (text) items.push({ role: "assistant", content: text });
      for (const tc of message.tool_calls ?? []) {
        items.push({
          type: "function_call",
          call_id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        });
      }
      continue;
    }

    // user (and any unknown role, coerced to user)
    const content = Array.isArray(message.content)
      ? mapContentParts(message.content)
      : message.content;
    items.push({ role: "user", content });
  }

  return {
    input: items,
    instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
  };
}

function sameCallIds(
  native: readonly unknown[],
  calls: readonly { readonly id?: string }[]
): boolean {
  const nativeIds = native
    .filter(
      (item): item is { type: string; call_id: string } =>
        (item as { type?: string } | null)?.type === "function_call"
    )
    .map((item) => item.call_id);
  const ids = calls.map((call) => call.id ?? "");
  return nativeIds.length === ids.length && nativeIds.every((id, i) => id === ids[i]);
}

export function buildResponsesTools(tools: readonly ToolDefinition[]): OpenAIResponsesTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: buildToolDescription(t),

    parameters: t.inputSchema as any,
    // Non-strict: workglow tool schemas are not guaranteed to satisfy the
    // additionalProperties:false / all-required constraints strict mode demands.
    strict: false,
  }));
}

/**
 * Map workglow `toolChoice` to a Responses `tool_choice`. Responses accepts the
 * same keywords as Chat Completions and a named-function form (`{type, name}` —
 * note: flatter than the chat `{type, function:{name}}`).
 */
export function mapResponsesToolChoice(toolChoice: string | undefined): OpenAIResponsesToolChoice {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  return { type: "function", name: toolChoice };
}

/**
 * Parse a non-streaming Responses `output[]` array into workglow
 * {@link ToolCalls}. Picks `function_call` items and ignores message / reasoning
 * items. Used by any synchronous (non-stream) caller.
 */
export function parseResponsesToolCalls(output: readonly any[] | undefined): ToolCalls {
  const result: ToolCalls = [];
  if (!output) return result;
  let idx = 0;
  for (const item of output) {
    if (item?.type !== "function_call") continue;
    const id =
      (item.call_id as string | undefined) ?? (item.id as string | undefined) ?? `call_${idx}`;
    const name = item.name as string;
    const parsed = parseToolArgs(typeof item.arguments === "string" ? item.arguments : "");
    const input = sanitizeToolArgs(parsed) as Record<string, unknown>;
    result.push({ id, name, input });
    idx++;
  }
  return result;
}

interface ResponsesToolCallEntry {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Adapt an OpenAI **Responses** streaming response to workglow stream events.
 * Forwards via the `emit` callback:
 *  - `text-delta` for each `response.output_text.delta`.
 *  - `refusal` for each `response.refusal.delta` (folded into the reserved
 *    `refusal` output field so a decline is distinguishable from an answer).
 *  - `object-delta` (single-element array) per function-call args delta, keyed
 *    by the output item so concurrent tool calls (distinct `output_index`) never
 *    collide. The downstream `StreamProcessor` upserts by `id`.
 *
 * Reasoning-summary and lifecycle events are ignored here. The caller emits its
 * own `finish` event after this returns (per the streaming convention). Generic
 * over the output type so non-tool-calling run-fns (TextGeneration / Rewriter /
 * Summary) can pass their own `emit` under `strictFunctionTypes`.
 *
 * Returns the token accounting off the terminal `response.completed` event —
 * the Responses API reports usage there unprompted — or `undefined` when the
 * stream ended without one. The caller attaches it to its `finish` event as a
 * sibling of `data`.
 *
 * Pass `promptText` to emit a provisional ↑ estimate before the first delta —
 * Responses only attaches billed usage to the terminal lifecycle event.
 */
export async function accumulateOpenAIResponsesStream<Output = Record<string, any>>(
  stream: AsyncIterable<any>,
  emit: (event: StreamEvent<Output>) => void,
  options: {
    readonly promptText?: string | undefined;
    readonly nativeTurnProvider?: string | undefined;
  } = {}
): Promise<Usage | undefined> {
  // Keyed by the output item's stable id (`item.id` on `output_item.{added,done}`,
  // `item_id` on `function_call_arguments.delta`). Falls back to `output_index`
  // only for gateways that omit both — keying purely on `output_index` collapses
  // concurrent function calls that share (or lack) the index onto one slot,
  // silently dropping every call but the last.
  const toolCalls = new Map<string, ResponsesToolCallEntry>();
  // Every finished output item by position, for replay on the next round.
  const outputItems = new Map<number, unknown>();
  // Responses only reports billed usage on the terminal lifecycle event; when the
  // caller supplies promptText, estimate ↑ before the first delta and ↓ from
  // content / tool-arg deltas so the CLI counter moves during the call. The
  // caller still attaches the provider total to `finish.usage`.
  const provisionalUsage =
    options.promptText !== undefined ? createEstimatedOutputUsageReporter(emit) : undefined;
  if (provisionalUsage && options.promptText !== undefined) {
    provisionalUsage.onPrompt(options.promptText);
  }
  let usage: Usage | undefined;

  const emitToolCall = (entry: ResponsesToolCallEntry): void => {
    const parsed = parseToolArgs(entry.arguments);
    const sanitized = sanitizeToolArgs(parsed) as Record<string, unknown>;
    emit({
      type: "object-delta",
      port: "toolCalls",
      objectDelta: [{ id: entry.id, name: entry.name, input: sanitized }],
    });
  };

  for await (const event of stream) {
    switch (event?.type) {
      case "response.output_text.delta": {
        const delta: string = event.delta ?? "";
        if (delta) {
          provisionalUsage?.onText(delta);
          emit({ type: "text-delta", port: "text", textDelta: delta });
        }
        break;
      }

      case "response.refusal.delta": {
        // Surface refusals as a first-class refusal event (folded into the
        // reserved `refusal` output field) rather than as ordinary text, so the
        // caller can distinguish a decline from a normal answer.
        const delta: string = event.delta ?? "";
        if (delta) emit({ type: "refusal", refusal: delta });
        break;
      }

      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "function_call") {
          const key = String(event.item?.id ?? event.item_id ?? event.output_index ?? 0);
          toolCalls.set(key, {
            id: (item.call_id as string) || (item.id as string) || `call_${key}`,
            name: (item.name as string) ?? "",
            arguments: (item.arguments as string) ?? "",
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        // Delta events carry `item_id` (not `item.id`); prefer it. Fall back to
        // `output_index` when no entry is registered under the id — the added
        // event may have registered under the index alone for legacy shapes.
        const idKey = event.item_id ?? event.item?.id;
        const indexKey = event.output_index;
        let key: string;
        let entry: ResponsesToolCallEntry | undefined;
        if (idKey !== undefined && toolCalls.has(String(idKey))) {
          key = String(idKey);
          entry = toolCalls.get(key);
        } else if (indexKey !== undefined && toolCalls.has(String(indexKey))) {
          key = String(indexKey);
          entry = toolCalls.get(key);
        } else {
          // Defensive: a delta arrived before we saw `output_item.added`.
          key = String(idKey ?? indexKey ?? 0);
          entry = { id: (event.item_id as string) || `call_${key}`, name: "", arguments: "" };
          toolCalls.set(key, entry);
        }
        const argDelta: string = event.delta ?? "";
        entry!.arguments += argDelta;
        // Argument JSON is also generated text — count it so a tools-only reply
        // still ticks the ↓ counter (content deltas alone would stay silent).
        if (argDelta) provisionalUsage?.onText(argDelta);
        emitToolCall(entry!);
        break;
      }

      case "response.output_item.done": {
        const item = event.item;
        if (item) {
          outputItems.set(
            typeof event.output_index === "number" ? event.output_index : outputItems.size,
            item
          );
        }
        if (item?.type === "function_call") {
          // Same lookup order as delta: id first, then output_index, so an entry
          // registered under either shape by `added` is found.
          const idKey = event.item?.id ?? event.item_id;
          const indexKey = event.output_index;
          let key: string;
          let entry: ResponsesToolCallEntry | undefined;
          if (idKey !== undefined && toolCalls.has(String(idKey))) {
            key = String(idKey);
            entry = toolCalls.get(key);
          } else if (indexKey !== undefined && toolCalls.has(String(indexKey))) {
            key = String(indexKey);
            entry = toolCalls.get(key);
          } else {
            key = String(idKey ?? indexKey ?? 0);
            entry = {
              id: (item.call_id as string) || (item.id as string) || `call_${key}`,
              name: (item.name as string) ?? "",
              arguments: "",
            };
          }
          // The `done` item carries the authoritative full arguments string.
          if (typeof item.arguments === "string") entry!.arguments = item.arguments;
          if (item.name) entry!.name = item.name;
          emitToolCall(entry!);
        }
        break;
      }

      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        // Terminal lifecycle events carry the authoritative token accounting.
        // An incomplete/failed response still consumed tokens, so its usage is
        // recorded too rather than being dropped as a non-success.
        usage = mapOpenAIResponsesUsage(event.response?.usage) ?? usage;
        break;
      }

      default:
        // Ignore the remaining lifecycle events (created/in_progress),
        // reasoning summaries, and non-function tool events.
        break;
    }
  }

  if (options.nativeTurnProvider !== undefined && outputItems.size > 0) {
    const items = [...outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    emit({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: options.nativeTurnProvider, payload: JSON.stringify(items) },
    } as StreamEvent<Output>);
  }

  provisionalUsage?.flush();
  return usage;
}

/**
 * Flatten Responses `instructions` + `input` into one string for the provisional
 * ↑ estimate. Multimodal / tool items contribute only their string content.
 */
export function promptTextForResponsesUsageEstimate(params: {
  readonly instructions?: unknown;
  readonly input?: unknown;
}): string {
  const parts: string[] = [];
  if (typeof params.instructions === "string" && params.instructions) {
    parts.push(params.instructions);
  }
  if (typeof params.input === "string") {
    if (params.input) parts.push(params.input);
    return parts.join("\n");
  }
  if (!Array.isArray(params.input)) return parts.join("\n");
  for (const item of params.input) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string") {
      if (content) parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") {
        if (block) parts.push(block);
      } else if (block && typeof block === "object") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text) parts.push(text);
      }
    }
  }
  return parts.join("\n");
}
