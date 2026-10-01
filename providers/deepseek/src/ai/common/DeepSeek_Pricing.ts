/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing, ModelTimingTier } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

/**
 * The windows DeepSeek bills at half its peak rates, for every model. Peak is
 * 01:00-04:00 and 06:00-10:00 UTC on weekdays; everything else is off-peak.
 * These two daily windows cover the weekday gaps; a clock window cannot drop
 * weekend mornings, which the published table also treats as off-peak, so a
 * weekend call in a peak hour is priced at the peak rate.
 */
function offPeak(rates: { input: number; output: number; cached: number }): ModelTimingTier[] {
  return [
    { start: "10:00", end: "01:00", pricing: { ...rates } },
    { start: "04:00", end: "06:00", pricing: { ...rates } },
  ];
}

const DEEPSEEK_OFF_PEAK: ModelTimingTier[] = offPeak({ input: 0.66, output: 1.98, cached: 0.022 });

const DEEPSEEK_PRO: ModelPricing = {
  currency: "USD",
  input: 1.32,
  output: 3.96,
  cached: 0.044,
  timingTiers: DEEPSEEK_OFF_PEAK,
};

const DEEPSEEK_FLASH_OFF_PEAK: ModelTimingTier[] = offPeak({
  input: 0.15,
  output: 0.6,
  cached: 0.003,
});

/** Peak list rates for DeepSeek Flash; the dated and versioned ids share this card. */
const DEEPSEEK_FLASH: ModelPricing = {
  currency: "USD",
  input: 0.3,
  output: 1.2,
  cached: 0.006,
  timingTiers: DEEPSEEK_FLASH_OFF_PEAK,
};

/**
 * Public list pricing for DeepSeek models (USD per 1M tokens).
 */
export const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  "deepseek-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash-0731": DEEPSEEK_FLASH,
  "deepseek-v4-pro-0813": DEEPSEEK_PRO,
  "deepseek-v4-pro": DEEPSEEK_PRO,
  "deepseek-chat": { currency: "USD", input: 0.14, output: 0.28, cached: 0.014 },
  "deepseek-reasoner": { currency: "USD", input: 0.55, output: 2.19, cached: 0.14 },
};

/**
 * Resolve list pricing for a DeepSeek model id.
 */
export function getDeepSeekModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(DEEPSEEK_PRICING, modelId, ["deepseek/"]);
}
