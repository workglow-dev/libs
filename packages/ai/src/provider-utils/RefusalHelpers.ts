/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";

/**
 * Emit a provider-agnostic model refusal. Every provider maps its native refusal
 * signal (OpenAI `response.refusal.delta`, Anthropic `stop_reason: "refusal"`,
 * Gemini `finishReason: SAFETY`/`blockReason`, …) through this so refusals surface
 * uniformly. The task-graph `StreamProcessor` / `StreamEventAccumulator` fold the
 * refusal into the reserved `refusal` output field; the task still COMPLETES.
 *
 * `refusal` may be emitted incrementally (consumer concatenates); `category` is an
 * optional normalized reason (e.g. `"output-refusal"`, `"input-blocked"`).
 */
export function emitRefusal<Output = Record<string, any>>(
  emit: (event: StreamEvent<Output>) => void,
  refusal: string,
  category?: string
): void {
  emit({ type: "refusal", refusal, ...(category !== undefined ? { category } : {}) });
}

/** Shown as the refusal when a provider ends a stream with `content_filter` and says nothing else. */
export const CONTENT_FILTER_REFUSAL_TEXT =
  "The response was withheld by the provider's content filter.";

export interface IChatRefusalReader {
  /**
   * Reads one chat-completions choice. Emits the choice's `delta.refusal`, and,
   * when the stream ends with `finish_reason: "content_filter"` without any
   * refusal text having arrived, a generic refusal: a filtered response can be
   * empty and carry no `refusal` string at all, which would otherwise complete
   * as a normal answer.
   *
   * Text streamed before a refusal arrives is left as streamed: the stream
   * cannot say it was never given, and a consumer detects the refusal on the
   * reserved `refusal` output.
   */
  read(
    choice:
      | {
          // Typed loosely on purpose: an SDK's delta type may not declare `refusal`,
          // though the wire carries it, so it is checked at runtime below.
          readonly delta?: object | null;
          readonly finish_reason?: string | null;
        }
      | undefined
  ): void;
}

/** One reader per call: it remembers whether a refusal was already emitted. */
export function createChatRefusalReader<Output = Record<string, any>>(
  emit: (event: StreamEvent<Output>) => void
): IChatRefusalReader {
  let emitted = false;
  return {
    read(choice) {
      const refusal = (choice?.delta as { refusal?: unknown } | null | undefined)?.refusal;
      if (typeof refusal === "string" && refusal.length > 0) {
        emitted = true;
        emitRefusal(emit, refusal);
      }
      if (choice?.finish_reason === "content_filter" && !emitted) {
        emitted = true;
        emitRefusal(emit, CONTENT_FILTER_REFUSAL_TEXT, "output-refusal");
      }
    },
  };
}
