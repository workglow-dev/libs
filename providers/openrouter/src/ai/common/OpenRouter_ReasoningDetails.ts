/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage, ContentBlockReasoning } from "@workglow/ai";
import type { OpenAICompatMessage } from "@workglow/ai/worker";

/** Fields of a reasoning detail whose streamed pieces are text to be joined. */
const CONCATENATED_KEYS: ReadonlySet<string> = new Set(["text", "summary", "data"]);

/**
 * Joins the pieces of `reasoning_details` OpenRouter streams on
 * `choices[0].delta`. Each piece carries the `index` of the item it belongs to.
 */
export interface ReasoningDetailAccumulator {
  readonly entries: Map<number, Record<string, unknown>>;
  /** The joined items by index, or `undefined` when no piece arrived. */
  items(): unknown[] | undefined;
}

export function createReasoningDetailAccumulator(): ReasoningDetailAccumulator {
  const entries = new Map<number, Record<string, unknown>>();
  return {
    entries,
    items() {
      if (entries.size === 0) return undefined;
      return [...entries.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    },
  };
}

/** Folds one streamed `reasoning_details` array into the accumulator. */
export function mergeReasoningDetailDelta(acc: ReasoningDetailAccumulator, delta: unknown): void {
  if (!Array.isArray(delta)) return;
  for (const piece of delta) {
    if (piece === null || typeof piece !== "object" || Array.isArray(piece)) continue;
    const incoming = piece as Record<string, unknown>;
    const index =
      typeof incoming.index === "number" && Number.isFinite(incoming.index)
        ? incoming.index
        : nextIndex(acc);
    const existing = acc.entries.get(index);
    if (!existing) {
      acc.entries.set(index, { ...incoming });
      continue;
    }
    for (const [key, value] of Object.entries(incoming)) {
      const current = existing[key];
      existing[key] =
        CONCATENATED_KEYS.has(key) && typeof current === "string" && typeof value === "string"
          ? current + value
          : value;
    }
  }
}

function nextIndex(acc: ReasoningDetailAccumulator): number {
  let max = -1;
  for (const index of acc.entries.keys()) max = Math.max(max, index);
  return max + 1;
}

/** What one round's native turn carries: its reasoning and the calls it was written beside. */
export interface ReasoningTurn {
  readonly callIds: readonly string[];
  readonly details: readonly unknown[];
}

/**
 * Whether the details stand as the model wrote them. An Anthropic thinking
 * block streamed through OpenRouter is only replayable with its signature, and
 * the stream can end before that arrives.
 */
function isReplayable(details: readonly unknown[]): boolean {
  return !details.some((detail) => {
    if (detail === null || typeof detail !== "object") return false;
    const { type, format, signature } = detail as Record<string, unknown>;
    return (
      type === "reasoning.text" &&
      typeof format === "string" &&
      format.startsWith("anthropic-") &&
      !(typeof signature === "string" && signature.length > 0)
    );
  });
}

/**
 * The native-turn payload for a round, or `undefined` when the details cannot
 * be replayed and the turn is better rebuilt.
 */
export function encodeReasoningTurn(
  callIds: readonly string[],
  details: readonly unknown[]
): string | undefined {
  if (!isReplayable(details)) return undefined;
  return JSON.stringify({ callIds, details });
}

function decodeReasoningTurn(payload: string): ReasoningTurn | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { callIds, details } = parsed as Record<string, unknown>;
  if (!Array.isArray(details)) return undefined;
  if (!Array.isArray(callIds) || !callIds.every((id) => typeof id === "string")) return undefined;
  return { callIds: callIds as string[], details };
}

/**
 * OpenRouter reads an assistant turn's reasoning back as `reasoning_details`.
 * `converted` is the shared converter's output for `history`, which keeps one
 * assistant message per assistant turn, in order. Each turn's own reasoning
 * block, written by `nativeKey`, is attached to its message only while the
 * turn's tool-call ids still equal the ones the details were written beside:
 * a host that changed or dropped a call id gets the rebuilt turn. The inputs
 * are not mutated.
 */
export function withReasoningDetails(
  converted: readonly OpenAICompatMessage[],
  history: ReadonlyArray<ChatMessage> | undefined,
  nativeKey: string
): Array<OpenAICompatMessage & { reasoning_details?: readonly unknown[] }> {
  const turns = (history ?? []).filter((message) => message.role === "assistant");
  const aligned =
    turns.length === converted.filter((message) => message.role === "assistant").length;
  let next = 0;
  return converted.map((message) => {
    if (message.role !== "assistant" || !aligned) return message;
    const turn = turns[next++]!;
    const block = turn.content.find(
      (b): b is ContentBlockReasoning =>
        b.type === "reasoning" && b.provider === nativeKey && b.payload !== undefined
    );
    const decoded = block === undefined ? undefined : decodeReasoningTurn(block.payload!);
    if (decoded === undefined) return message;
    const sent = (message.tool_calls ?? []).map((call) => call.id);
    const matches =
      sent.length === decoded.callIds.length && sent.every((id, i) => id === decoded.callIds[i]);
    return matches ? { ...message, reasoning_details: decoded.details } : message;
  });
}
