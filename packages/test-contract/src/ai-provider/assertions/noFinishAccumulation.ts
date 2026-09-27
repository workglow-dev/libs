/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";
import { expect } from "vitest";

/**
 * A run-fn streams its output and `TaskRunner` accumulates it. A `finish` that
 * also carries the accumulated value hands the accumulator a second, competing
 * copy of the same content, and the accumulator has to decide which one wins.
 *
 * The rule is stated in the repository's own guidance for writing a run-fn, but
 * prose does not fail a build: four local providers carried this for nine review
 * cycles, and one of them ended up pinned by a passing test. This is the form
 * that goes red.
 *
 * Deliberately a check over a **recorded event list** rather than a live
 * conformance block: the defect is visible in what a run-fn emits against a fake
 * engine, so it costs no model call and a provider's own unit tests can assert
 * it. The exceptions the guidance names — meta-ops, embeddings, one-shot
 * vision/classification, and the `object` a structured-generation run-fn must
 * put on `finish` — are the reason this is opt-in per suite rather than applied
 * to every stream.
 */

/** A string a delta already delivered, or `undefined` when none did. */
function accumulatedText(events: ReadonlyArray<StreamEvent<never>>, port: string): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text-delta" && event.port === port) text += event.textDelta;
  }
  return text;
}

function finishData(
  events: ReadonlyArray<StreamEvent<never>>
): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "finish") {
      const data = (event as { data?: unknown }).data;
      return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : undefined;
    }
  }
  return undefined;
}

export interface NoFinishAccumulationOptions {
  /**
   * Fields a `finish` is allowed to carry despite the rule — `object` for a
   * structured-generation run-fn, and anything a one-shot capability defines as
   * its whole output. Naming them is the point: an exemption is a decision,
   * not a default.
   */
  readonly allowFields?: readonly string[];
}

/**
 * Asserts that a `finish` carries no output of its own.
 *
 * Checks two shapes, which are the two that have actually occurred: a `text`
 * field carrying the generation, and a non-empty array field (`toolCalls`).
 * Neither is judged against whether a matching delta exists — the run-fn that
 * emits its tool calls ONLY on `finish` is the plain form of the defect, and
 * `TaskRunner` accumulates from the deltas, so that output reaches the task's
 * port empty. A matching delta makes the report more specific, never the
 * difference between passing and failing.
 *
 * An empty string and an empty array pass — that is what a compliant run-fn
 * emits when the output type requires the field to exist.
 */
export function expectNoFinishAccumulation(
  events: ReadonlyArray<StreamEvent<never>>,
  options: NoFinishAccumulationOptions = {}
): void {
  const data = finishData(events);
  if (data === undefined) return;
  const allowed = new Set(options.allowFields ?? []);

  for (const [field, value] of Object.entries(data)) {
    if (allowed.has(field)) continue;

    if (typeof value === "string" && value.length > 0) {
      const streamed = accumulatedText(events, field);
      const repeatsDeltas =
        streamed.length > 0 && (streamed.includes(value) || value.includes(streamed));
      expect(
        value,
        `finish.${field} ` +
          (repeatsDeltas
            ? `repeats text the deltas already delivered`
            : `carries text no text-delta on port "${field}" delivered, so nothing accumulates it`) +
          ` — the stream is the one copy, and TaskRunner accumulates it. Emit "" here, or name ` +
          `"${field}" in allowFields if this capability's output genuinely lives on finish.`
      ).toBe("");
    }

    if (Array.isArray(value) && value.length > 0) {
      const streamedPort = events.some(
        (event) => event.type === "object-delta" && event.port === field
      );
      expect(
        value,
        `finish.${field} carries ${value.length} entr${value.length === 1 ? "y" : "ies"} ` +
          (streamedPort
            ? `that an object-delta on port "${field}" already emitted`
            : `that no object-delta on port "${field}" emitted, so nothing accumulates them and ` +
              `the task's "${field}" port comes back empty`) +
          `. Emit [] here, or name "${field}" in allowFields.`
      ).toEqual([]);
    }
  }
}
