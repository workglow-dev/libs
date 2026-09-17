/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { USAGE_PROMPT_FIELDS } from "@workglow/task-graph";
import { resolveEffectiveRates } from "../model/ModelPricing";
import type { ModelPricing } from "../model/ModelSchema";

/** Per-token-hour counter a provider-side cache accrues while it lives. */
export const CACHE_STORAGE_TOKEN_HOURS_KEY = "cacheStorageTokenHours";

export interface CostEstimate {
  readonly currency: string;
  readonly amount: number;
  /** Counters that were spent but carry no declared rate. */
  readonly unpriced: readonly string[];
  /** True when the provider stated this cost; false when derived locally. */
  readonly stated: boolean;
}

/** Counters priced at their own rate. Disjoint, so this is a plain sum. */
const PRICED_FIELDS = [
  "input",
  "output",
  "cached",
  "cacheWrite",
  "imageInput",
  "imageCached",
] as const;

const PER_MILLION = 1_000_000;

/**
 * The whole prompt this request sent, which is what a provider's context
 * threshold measures: text input, cache reads/writes, and image input/cache
 * are disjoint counters that together make up one prompt. `undefined` when none
 * of them was reported, so a usage that says nothing about its prompt selects
 * no tier rather than the smallest one.
 */
function promptTokens(usage: Usage): number | undefined {
  const slices = USAGE_PROMPT_FIELDS.map((field) => usage[field]);
  if (slices.every((slice) => slice === undefined)) return undefined;
  return slices.reduce<number>((sum, slice) => sum + (slice ?? 0), 0);
}

export interface EstimateCostOptions {
  /**
   * When the request ran, for a rate card with a time-of-day tier. Defaults to
   * now — right for a live run, wrong for one replayed from a log, so pass the
   * request's own instant when pricing after the fact. A figure rendered
   * repeatedly (a footer, a report) must pass one: priced against the render
   * clock, the same usage costs a different amount once the clock crosses a
   * discount boundary.
   */
  readonly at?: Date | number | undefined;
}

/**
 * Estimate what one {@link Usage} cost under a model's declared rates.
 *
 * Returns `undefined` — never `0` — when nothing can be priced, so a missing
 * estimate never reads as a free run. `unpriced` names counters that were spent
 * with no rate declared, which is what lets a caller present a partial figure
 * honestly instead of a confident wrong one.
 *
 * `reasoning` and `total` are never priced and never reported unpriced: the
 * first is contained in `output` and the second covers the whole request, so
 * charging either would count the same tokens twice.
 *
 * A usage whose counters are heuristic estimates (`usage.estimated`) is not
 * priced at all: a dollar figure derived from a character count reads exactly
 * like one derived from billed tokens, and nothing downstream distinguishes them.
 *
 * Usage and timing tiers are resolved first, so the rates charged are the ones
 * that applied to this request rather than the card's headline numbers. See
 * {@link resolveEffectiveRates}.
 */
export function estimateCost(
  usage: Usage,
  pricing: ModelPricing | undefined,
  options: EstimateCostOptions = {}
): CostEstimate | undefined {
  if (usage.estimated) return undefined;
  // A stated fact beats a derived one: OpenRouter reports credits actually
  // charged, which no local rate card can improve on.
  const stated = usage.extra?.cost;
  if (typeof stated === "number" && Number.isFinite(stated)) {
    return {
      currency: pricing?.currency ?? "USD",
      amount: stated,
      unpriced: [],
      stated: true,
    };
  }

  if (!pricing) return undefined;

  const rates = resolveEffectiveRates(pricing, {
    inputTokens: promptTokens(usage),
    at: options.at,
  });

  let amount = 0;
  let priced = false;
  const unpriced: string[] = [];

  for (const field of PRICED_FIELDS) {
    const tokens = usage[field];
    if (tokens === undefined) continue;
    const rate = rates[field];
    if (rate === undefined) {
      if (tokens > 0) unpriced.push(field);
      continue;
    }
    const unitRate =
      typeof rate === "number"
        ? rate
        : typeof rate === "object" && rate !== null
          ? (rate.cacheWrite5m ?? rate.cacheWrite1h)
          : undefined;
    if (unitRate === undefined) {
      if (tokens > 0) unpriced.push(field);
      continue;
    }
    amount += (tokens * unitRate) / PER_MILLION;
    priced = true;
  }

  const tokenHours = usage.extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY];
  if (typeof tokenHours === "number" && Number.isFinite(tokenHours)) {
    if (rates.cacheStoragePerHour === undefined) {
      if (tokenHours > 0) unpriced.push(CACHE_STORAGE_TOKEN_HOURS_KEY);
    } else {
      amount += (tokenHours * rates.cacheStoragePerHour) / PER_MILLION;
      priced = true;
    }
  }

  if (!priced) return undefined;
  return { currency: pricing.currency, amount, unpriced, stated: false };
}

/**
 * Fold several {@link CostEstimate}s into one. Returns `undefined` when nothing
 * was priced, or when the inputs disagree on currency (mixing units silently
 * would invent a number).
 *
 * `unpriced` is the union across contributors; `stated` is true only when every
 * contributor was provider-stated.
 */
export function sumCostEstimates(estimates: readonly CostEstimate[]): CostEstimate | undefined {
  if (estimates.length === 0) return undefined;
  const currency = estimates[0]!.currency;
  if (estimates.some((estimate) => estimate.currency !== currency)) return undefined;

  let amount = 0;
  let stated = true;
  const unpriced: string[] = [];
  for (const estimate of estimates) {
    amount += estimate.amount;
    stated = stated && estimate.stated;
    for (const field of estimate.unpriced) {
      if (!unpriced.includes(field)) unpriced.push(field);
    }
  }
  return { currency, amount, unpriced, stated };
}
