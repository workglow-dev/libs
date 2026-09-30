/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util/worker";

/**
 * Per-(model, param) dedupe key set for penalty-drop warnings. The Responses
 * API silently ignores `frequency_penalty` / `presence_penalty`; a caller who
 * used them pre-0.3.26 needs to see it once per model per process, not on
 * every request.
 */
const warnedPenaltyDrops = new Set<string>();

export function warnPenaltyDroppedOnce(
  model: string,
  param: "frequencyPenalty" | "presencePenalty"
): void {
  const key = `${model}::${param}`;
  if (warnedPenaltyDrops.has(key)) return;
  warnedPenaltyDrops.add(key);
  getLogger().warn(
    `OpenAI Responses API does not accept ${param}; the value has been dropped ` +
      `for model "${model}". To use ${param}, pin @workglow/openai@0.3.25 or ` +
      `route the request to a non-OpenAI provider.`
  );
}

/**
 * Per-model dedupe key set for strict-downshift warnings. Structured generation
 * requests fall back from `strict: true` to `isStrictCompatibleSchema(schema)`
 * when the schema uses shapes strict rejects (anyOf, $ref, missing
 * additionalProperties:false, etc.); callers who relied on strict need to see
 * the downshift once per model per process.
 */
const warnedStrictDownshifts = new Set<string>();

export function warnStrictDowngradedOnce(model: string, reason: string): void {
  if (warnedStrictDownshifts.has(model)) return;
  warnedStrictDownshifts.add(model);
  getLogger().warn(
    `OpenAI structured generation for model "${model}" downshifted from ` +
      `strict:true to strict:false because the schema is not strict-compatible ` +
      `(${reason}). The response is validated by the consumer, but the ` +
      `provider-side strict guarantee is not applied. To keep strict, ` +
      `restructure the schema; to pin the previous behavior, use ` +
      `@workglow/openai@0.3.25.`
  );
}

const warnedTemperatureDrops = new Set<string>();

export function warnTemperatureDroppedOnce(model: string, effort: string | undefined): void {
  const key = `${model}::${effort ?? ""}`;
  if (warnedTemperatureDrops.has(key)) return;
  warnedTemperatureDrops.add(key);
  getLogger().warn(
    `OpenAI model "${model}" rejects temperature alongside reasoning` +
      (effort ? ` effort "${effort}"` : "") +
      `; the pinned temperature has been dropped.`
  );
}

/** @internal test helper — clear all dedupe sets. */
export function _resetOpenAIResponsesWarnings(): void {
  warnedTemperatureDrops.clear();
  warnedPenaltyDrops.clear();
  warnedStrictDownshifts.clear();
}
