/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/ai";
import { toUsageCount, usageOrUndefined } from "@workglow/ai/provider-utils";

/**
 * Normalize TypeSafe's `usage` block into the provider-agnostic {@link Usage}.
 *
 * The wire shape is two counters and nothing else: `input_tokens` and
 * `output_tokens`. Everything the vendor does not report stays `undefined`
 * rather than `0` — TypeSafe has no prompt cache and quotes no total, and
 * writing zeros for them would read as "billed nothing" where the truth is
 * "told us nothing". `total` in particular is never synthesized by addition.
 *
 * Only `input_tokens` is billed; output tokens are free on TypeSafe's card, and
 * that is stated in the rate card rather than by dropping the counter here.
 */
export function mapTypeSafeAiUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as { input_tokens?: unknown; output_tokens?: unknown };
  return usageOrUndefined({
    input: toUsageCount(payload.input_tokens),
    output: toUsageCount(payload.output_tokens),
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  });
}

/**
 * Fold one request's usage into a running total across a multi-request run.
 *
 * A rerank scores each candidate in its own request, so what the task reports
 * has to be the sum of them — one request's counters would understate the run
 * by the number of candidates. A counter neither side reported stays
 * unreported; a counter only one side reported is carried through, because the
 * alternative is losing a stated figure to an absent one.
 */
export function addTypeSafeAiUsage(
  total: Usage | undefined,
  next: Usage | undefined
): Usage | undefined {
  if (total === undefined) return next;
  if (next === undefined) return total;
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return usageOrUndefined({
    input: sum(total.input, next.input),
    output: sum(total.output, next.output),
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  });
}
