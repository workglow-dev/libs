/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { USAGE_COUNTER_FIELDS, USAGE_PROMPT_FIELDS } from "@workglow/task-graph";
import type { ModelPricing } from "../model/ModelSchema";
import type { CostEstimate, EstimateCostOptions } from "./CostEstimate";
import { estimateCost } from "./CostEstimate";

/**
 * How much of a {@link Usage} to render. All three levels obey the same
 * underlying rules — unreported renders as nothing, a stated all-zero renders as
 * "cached", and `↑` is always the whole prompt — and differ only in breadth.
 */
export type UsageDetail = "directional" | "cumulative" | "detailed";

const group = (n: number): string => n.toLocaleString("en-US");

/**
 * Counters only an image model ever fills. A `Usage` that omits them said
 * nothing about image tokens, which is not the same as reporting a count — so
 * requiring them to be a stated `0` would keep an all-zero text usage from
 * reading as the replayed cache hit it is.
 */
const OPTIONAL_COUNTER_FIELDS = new Set<string>(["imageInput", "imageCached"]);

/** True when the provider stated 0 for every counter — a replayed cache hit. */
function isStatedZero(usage: Usage): boolean {
  return USAGE_COUNTER_FIELDS.every((field) => {
    const value = usage[field];
    return value === 0 || (value === undefined && OPTIONAL_COUNTER_FIELDS.has(field));
  });
}

function hasAnyCounter(usage: Usage): boolean {
  return USAGE_COUNTER_FIELDS.some((field) => usage[field] !== undefined);
}

/**
 * The whole prompt. `input`, `cached`, `cacheWrite`, `imageInput` and
 * `imageCached` are disjoint slices of it, so the base-rate bucket alone is not
 * the figure the `↑` arrow claims to be: a warm cache-checkpoint call reports
 * nearly its entire prompt under `cached` and would render `↑3` for an 11k-token
 * prompt.
 *
 * Sums only the counters the provider stated, so a prompt no counter reported
 * stays unreported rather than becoming a synthesized `0`.
 */
function promptTotal(usage: Usage): number | undefined {
  const slices = USAGE_PROMPT_FIELDS.map((field) => usage[field]);
  if (slices.every((slice) => slice === undefined)) return undefined;
  return slices.reduce<number>((sum, slice) => sum + (slice ?? 0), 0);
}

export function formatUsage(usage: Usage | undefined, detail: UsageDetail): string {
  if (!usage || !hasAnyCounter(usage)) return "";
  if (isStatedZero(usage)) return "cached";

  const prompt = promptTotal(usage);
  const up = prompt === undefined ? "" : `↑${group(prompt)}`;
  const down = usage.output === undefined ? "" : `↓${group(usage.output)}`;

  if (detail === "cumulative") return [up, down].filter(Boolean).join(" ");

  if (detail === "directional") {
    const bits: string[] = [];
    if (usage.cached !== undefined) bits.push(`${group(usage.cached)} cached`);
    if (usage.imageCached !== undefined) bits.push(`${group(usage.imageCached)} image cached`);
    const cached = bits.length === 0 ? "" : `(${bits.join(", ")})`;
    return [up, cached, down].filter(Boolean).join(" ");
  }

  const parts: string[] = [];
  if (up) parts.push(up);
  if (down) parts.push(down);
  if (usage.cached !== undefined) parts.push(`cached ${group(usage.cached)}`);
  if (usage.cacheWrite !== undefined) parts.push(`cache-write ${group(usage.cacheWrite)}`);
  if (usage.imageInput !== undefined) parts.push(`image ${group(usage.imageInput)}`);
  if (usage.imageCached !== undefined) parts.push(`image-cached ${group(usage.imageCached)}`);
  if (usage.reasoning !== undefined) parts.push(`reasoning ${group(usage.reasoning)}`);
  if (usage.total !== undefined) parts.push(`total ${group(usage.total)}`);
  return parts.join(" ");
}

/**
 * Render a cost estimate. A `~` prefix marks an estimate that could not price
 * every counter that was spent, so a partial figure is never mistaken for an
 * exact one.
 */
export function formatCost(estimate: CostEstimate | undefined): string {
  if (!estimate) return "";
  const symbol = estimate.currency === "USD" ? "$" : `${estimate.currency} `;
  const prefix = estimate.unpriced.length > 0 ? "~" : "";
  // Four decimals is the usual billable grain, but OpenRouter micro-costs
  // (fractions of a cent on a short call) round to `$0.0000` at that width and
  // look like a free run — stretch precision until the first significant digit
  // shows, capped so a nano-dollar charge does not flood the row.
  const amount = formatCostAmount(estimate.amount);
  return `${prefix}${symbol}${amount}`;
}

function formatCostAmount(amount: number): string {
  if (amount === 0) return "0.0000";
  if (amount >= 0.0001) return amount.toFixed(4);
  const digits = Math.min(8, Math.max(4, Math.ceil(-Math.log10(amount)) + 1));
  return amount.toFixed(digits);
}

/**
 * Token counts plus a cost figure when one can be priced.
 *
 * A replayed cache hit stays `"cached"` with no dollar amount — it cost
 * nothing, and appending `$0.0000` would read as a priced run. Provider-stated
 * costs (`usage.extra.cost`) surface even when `pricing` is absent; otherwise
 * the rate card is required and an unpriceable spend stays tokens-only.
 *
 * Heuristic counters get a `~` and no cost figure: they are worth showing as
 * live feedback, but a reader must not mistake them for what was billed.
 *
 * `options.at` is the instant the request ran, forwarded to
 * {@link estimateCost}. A caller that re-renders — every live UI — should pass
 * it: without one, a card with a time-of-day tier prices against the render
 * clock, so a finished run's cost changes on screen as the clock crosses the
 * discount boundary.
 */
export function formatUsageWithCost(
  usage: Usage | undefined,
  detail: UsageDetail,
  pricing: ModelPricing | undefined,
  options: EstimateCostOptions = {}
): string {
  const tokens = formatUsage(usage, detail);
  if (!tokens || tokens === "cached") return tokens;
  if (usage?.estimated) return `~${tokens}`;
  const cost = formatCost(estimateCost(usage!, pricing, options));
  return cost ? `${tokens} ${cost}` : tokens;
}
