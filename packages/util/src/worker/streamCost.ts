/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** Recursion ceiling, so a cyclic or pathological payload cannot hang the walk. */
const MAX_DEPTH = 8;

/**
 * Approximate the buffering cost of one message crossing the worker port.
 *
 * Deliberately **structural** rather than typed against a stream-event union:
 * this package sits upstream of the one that defines those events, and the
 * number only has to be proportional to memory held — a credit window is a
 * throttle, not an accounting ledger. Binary dominates when present (bytes),
 * text counts its characters, and anything else costs a token so a flood of
 * tiny object deltas still moves the window.
 *
 * Never returns 0: a zero-cost item would let an unbounded number of messages
 * through a window that is supposed to bound them.
 */
export function streamChunkCost(value: unknown, depth: number = 0): number {
  if (depth > MAX_DEPTH) return 1;

  if (value === null || value === undefined) return 1;

  if (typeof value === "string") return Math.max(1, value.length);

  if (ArrayBuffer.isView(value)) return Math.max(1, value.byteLength);
  if (value instanceof ArrayBuffer) return Math.max(1, value.byteLength);

  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += streamChunkCost(item, depth + 1);
    return Math.max(1, total);
  }

  if (typeof value === "object") {
    let total = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      total += streamChunkCost(item, depth + 1);
    }
    return Math.max(1, total);
  }

  return 1;
}
