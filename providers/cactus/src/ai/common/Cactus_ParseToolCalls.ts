/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCall, ToolCalls } from "@workglow/ai";
import { createToolCallMarkupFilter } from "@workglow/ai/provider-utils";
import { sanitizeToolArgs } from "@workglow/ai/worker";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_FENCE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const THINK_FENCE = /<think>[\s\S]*?<\/think>/g;

/**
 * Removes the model's chain-of-thought.
 *
 * Needle v3 reasons before essentially every answer and v2 does so
 * occasionally, so a `<think>…</think>` block routinely precedes the payload.
 * It is commentary, never a tool call: dropping it first stops reasoning prose
 * from reaching the no-fence fallback in `needleToolCallPayloads`, and stops a
 * `<tool_call>` the model merely *talked about* inside its reasoning from being
 * read as one it actually emitted.
 *
 * A block cut short at the token limit has no closing tag and is left alone —
 * there is nothing after it to protect.
 */
export function stripNeedleReasoning(raw: string): string {
  return raw.replace(THINK_FENCE, "").trim();
}

/** A delta-stream filter: each delta in, the part a caller may see out. */
export interface NeedleTextFilter {
  /** The visible part of this delta; `""` when none of it is. */
  push(delta: string): string;
  /** The visible part of whatever is still held when the stream ends. */
  flush(): string;
}

/** Longest suffix of `text` that is a proper prefix of `tag`. */
function danglingPrefixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * The incremental form of {@link stripNeedleReasoning}, for the delta stream.
 *
 * `text` means the model's answer for v1 and v2, and it has to keep meaning
 * that for v3 — which reasons before essentially every answer. The parse path
 * already drops the `<think>` block; forwarding it to the `text` port anyway
 * would leave a host rendering the chain of thought beside the tool cards, and
 * a host logging `text` persisting it.
 *
 * Streaming makes this more than a `replace`: a tag can straddle a delta
 * boundary, so the filter holds back any trailing run that could still turn
 * into `<think>` and releases it once it cannot.
 *
 * `flush` exists for the case the fence never closes. A generation cut short
 * at the token limit has no `</think>`, and `stripNeedleReasoning` deliberately
 * leaves such a block alone — so the filter releases what it held rather than
 * swallowing the whole generation.
 */
export function createNeedleReasoningFilter(): NeedleTextFilter {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  /** Text not yet classifiable: a partial tag, or a fence still open. */
  let held = "";
  let inside = false;

  return {
    push(delta: string): string {
      held += delta;
      let visible = "";
      for (;;) {
        if (inside) {
          const close = held.indexOf(CLOSE);
          // No closing tag yet: keep holding, in case the stream ends here.
          if (close === -1) return visible;
          held = held.slice(close + CLOSE.length);
          inside = false;
          continue;
        }
        const open = held.indexOf(OPEN);
        if (open === -1) {
          const dangling = danglingPrefixLength(held, OPEN);
          visible += held.slice(0, held.length - dangling);
          held = held.slice(held.length - dangling);
          return visible;
        }
        visible += held.slice(0, open);
        // Keep the opening tag, so an unterminated block flushes intact.
        held = held.slice(open);
        inside = true;
      }
    },
    flush(): string {
      const rest = held;
      held = "";
      inside = false;
      return rest;
    },
  };
}

/**
 * Whether held bare text is what {@link parseNeedleToolCalls} reads as tool
 * calls — or the `[]` abstention — rather than an answer that happens to be
 * JSON. Only the former is on `toolCalls` already; the latter is the reply.
 */
function isBareToolCallPayload(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (Array.isArray(parsed) && parsed.length === 0) return true;
  const candidates: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.some((candidate, index) => toToolCall(candidate, index) !== undefined);
}

/**
 * The text a caller sees: the generation minus everything
 * {@link parseNeedleToolCalls} reads as something other than an answer —
 * reasoning, fenced payloads, and a bare payload.
 *
 * The payload is on `toolCalls` already. Left on `text` too, a host rendering
 * that port live shows the call's JSON typing itself out before the tool card
 * appears, which is what every generation would do: v2 and v3 stream the
 * fenced block token by token, and v1 streams its raw `<tool_call>` marker and
 * payload — with no closing tag — even though `run` returns the bare JSON.
 *
 * Three stages, in the order the parser reads the generation:
 *
 * 1. {@link createNeedleReasoningFilter} drops `<think>` blocks, so a fence the
 *    model only talked about counts for nothing below.
 * 2. {@link createToolCallMarkupFilter} drops each `<tool_call>` block, holding
 *    back a partial opening tag until it is disambiguated and suppressing an
 *    unclosed block to the end — the parser recovers that tail as a payload.
 * 3. The bare-payload gate. With no fence anywhere the parser takes the whole
 *    remaining generation as the payload, so visible text whose first
 *    non-blank character opens a JSON array or object is held: dropped at the
 *    end if it parses as tool calls (or the `[]` abstention), released if it
 *    is anything else — prose, or an answer that is itself JSON — or a fence
 *    turns up after all.
 *
 * Output that is nothing but whitespace is dropped at the end too: it is the
 * newline between `</think>` and `<tool_call>`, not an answer.
 */
export function createNeedleVisibleTextFilter(): NeedleTextFilter {
  const reasoning = createNeedleReasoningFilter();
  /** A `<tool_call>` opened outside reasoning, so no bare payload is read. */
  let sawFence = false;
  /** The end of the last routed delta, for an opening tag split across two. */
  let fenceTail = "";
  /** `lead`: only whitespace so far; `held`: a possible bare payload; `pass`: prose. */
  let mode: "lead" | "held" | "pass" = "lead";
  let held = "";
  let out = "";

  const release = (): void => {
    out += held;
    held = "";
    mode = "pass";
  };

  const markup = createToolCallMarkupFilter((text) => {
    if (mode === "pass") {
      out += text;
      return;
    }
    held += text;
    if (mode === "held") return;
    const start = text.search(/\S/);
    if (start === -1) return;
    const first = text[start];
    if (!sawFence && (first === "[" || first === "{")) mode = "held";
    else release();
  });

  const route = (text: string): void => {
    if (text.length === 0) return;
    const scan = fenceTail + text;
    if (scan.includes(TOOL_CALL_OPEN)) sawFence = true;
    fenceTail = scan.slice(-(TOOL_CALL_OPEN.length - 1));
    markup.feed(text);
    if (mode === "held" && sawFence) release();
  };

  const take = (): string => {
    const visible = out;
    out = "";
    return visible;
  };

  return {
    push(delta: string): string {
      route(reasoning.push(delta));
      return take();
    },
    flush(): string {
      route(reasoning.flush());
      markup.flush();
      if (mode === "held" && isBareToolCallPayload(held)) held = "";
      if (mode === "lead") held = "";
      release();
      return take();
    },
  };
}

/**
 * Needle v2 and v3 wrap each JSON payload in `<tool_call>…</tool_call>` and can
 * emit more than one block; v1 emits the JSON payload directly.
 *
 * Returns every fenced payload in order, or the whole string when no fence is
 * present. A generation cut short at the token limit loses its closing tag —
 * the text after the last opening tag is still the payload (its JSON may well
 * be complete), so it is recovered rather than dropped on the floor.
 *
 * `"[]"` from v2/v3 is a deliberate abstention — the model weighed the tools
 * and declined — and parses to zero calls, the same as no payload at all.
 */
export function needleToolCallPayloads(raw: string): readonly string[] {
  const trimmed = stripNeedleReasoning(raw);
  const payloads: string[] = [];
  // `matchAll` iterates a clone of the regex, so the module-level `/g` object
  // keeps `lastIndex === 0` and stays safe to share across calls.
  for (const match of trimmed.matchAll(TOOL_CALL_FENCE)) {
    const inner = match[1].trim();
    if (inner) payloads.push(inner);
  }
  if (payloads.length > 0) return payloads;

  const open = trimmed.lastIndexOf(TOOL_CALL_OPEN);
  if (open !== -1) {
    const tail = trimmed.slice(open + TOOL_CALL_OPEN.length).trim();
    return tail ? [tail] : [];
  }
  return trimmed ? [trimmed] : [];
}

function toToolCall(candidate: unknown, index: number): ToolCall | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as { readonly name?: unknown; arguments?: unknown; params?: unknown };
  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  return {
    id: `call_${index}`,
    name: record.name,
    input: sanitizeToolArgs(record.arguments ?? record.params ?? {}) as Record<string, unknown>,
  };
}

export function parseNeedleToolCalls(raw: string): ToolCalls {
  const calls: ToolCalls = [];
  for (const payload of needleToolCallPayloads(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A payload the model mangled must not discard the ones it got right.
      continue;
    }
    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = toToolCall(candidate, calls.length);
      if (call) calls.push(call);
    }
  }
  return calls;
}

/**
 * needle-rs v1 and v2 `run_stream` call `on_token(tokenId, piece)` — the text
 * is the second argument. v3 changed the shape: it calls `on_token(text)` with
 * the decoded delta alone, so a single string argument is the text itself. A
 * lone token id yields nothing, because emitting the number would inject
 * digits into the generated text.
 */
export function needleStreamPiece(
  tokenIdOrChunk: number | string,
  piece: string | undefined
): string {
  if (typeof piece === "string") return piece;
  return typeof tokenIdOrChunk === "string" ? tokenIdOrChunk : "";
}
