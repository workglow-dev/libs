/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCall, ToolCalls } from "@workglow/ai";
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
