/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { estimateCost, resolveEffectiveRates } from "@workglow/ai";
import { getDeepSeekModelPricing } from "@workglow/deepseek/ai";
import { describe, expect, it } from "vitest";

const at = (iso: string): Date => new Date(iso);

describe("DeepSeek price card", () => {
  it.each(["deepseek-flash", "deepseek-v4-pro"])(
    "bills %s at half rate outside the weekday peak hours",
    (model) => {
      const card = getDeepSeekModelPricing(model)!;
      const peak = resolveEffectiveRates(card, { at: at("2026-10-01T02:00:00Z") });
      const morningPeak = resolveEffectiveRates(card, { at: at("2026-10-01T08:00:00Z") });
      const gap = resolveEffectiveRates(card, { at: at("2026-10-01T05:00:00Z") });
      const evening = resolveEffectiveRates(card, { at: at("2026-10-01T17:00:00Z") });
      expect(morningPeak.input).toBe(peak.input);
      expect(gap.input).toBe(peak.input! / 2);
      expect(evening.output).toBe(peak.output! / 2);
    }
  );

  it("prices a measured batch as the account billed it", () => {
    // 2,933 calls between 15:38 and 18:48 UTC came to $6.07 on this card and
    // $6.08 off the account balance; one representative call at 17:00:
    const cost = estimateCost(
      {
        input: 68_243,
        cached: 1_257_216,
        output: 32_836,
        cacheWrite: 0,
        reasoning: undefined,
        total: undefined,
        extra: undefined,
      },
      getDeepSeekModelPricing("deepseek-flash"),
      { at: at("2026-10-01T17:00:00Z") }
    )!;
    expect(cost.amount).toBeCloseTo((68_243 * 0.15 + 1_257_216 * 0.003 + 32_836 * 0.6) / 1e6, 8);
  });
});
