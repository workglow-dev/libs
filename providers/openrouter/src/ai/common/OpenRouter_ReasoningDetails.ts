/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

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

/**
 * OpenRouter reads an assistant turn's reasoning back as `reasoning_details`.
 * The shared converter stages replayed items as `native_items`; this renames
 * them for the wire and leaves the input messages untouched.
 */
export function withReasoningDetails(
  messages: OpenAICompatMessage[]
): Array<Omit<OpenAICompatMessage, "native_items"> & { reasoning_details?: unknown[] }> {
  return messages.map((message) => {
    if (message.native_items === undefined) return message;
    const { native_items, ...rest } = message;
    return { ...rest, reasoning_details: native_items };
  });
}
