/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { estimateCost } from "@workglow/ai";
import { ANTHROPIC_PRICING } from "@workglow/anthropic/ai";
import { getGeminiModelPricing } from "@workglow/google-gemini/ai";
import { getOpenAiModelPricing } from "@workglow/openai/ai";
import type { Usage } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

const MILLION = 1_000_000;

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cached: undefined,
  cacheWrite: undefined,
  reasoning: undefined,
  total: undefined,
  extra: undefined,
});

const cost = (pricing: ModelPricing | undefined, input: number, output: number): number =>
  estimateCost(usage(input, output), pricing)!.amount;

/** USD per million input tokens actually charged for a prompt of this size. */
const inputRate = (pricing: ModelPricing | undefined, prompt: number): number =>
  (cost(pricing, prompt, 0) / prompt) * MILLION;

/**
 * Google publishes two rows for its Pro models: one for a prompt up to 200K
 * tokens and a higher one above it. A card carrying only the first prices a
 * 250K-token prompt at roughly half — and, because every counter it was handed
 * did have a rate, the figure prints without the `~` that marks a partial
 * estimate. The tiers are what keep the estimate on the published table.
 */
describe("Gemini long-context pricing", () => {
  it("charges gemini-2.5-pro's over-200K rates above the threshold", () => {
    const pricing = getGeminiModelPricing("gemini-2.5-pro");
    expect(inputRate(pricing, 199_000)).toBeCloseTo(1.25, 10);
    expect(inputRate(pricing, 250_000)).toBeCloseTo(2.5, 10);
    expect(cost(pricing, 250_000, MILLION)).toBeCloseTo((250_000 * 2.5) / MILLION + 15, 10);
  });

  it("puts a prompt of exactly 200K on the lower row", () => {
    expect(inputRate(getGeminiModelPricing("gemini-2.5-pro"), 200_000)).toBeCloseTo(1.25, 10);
  });

  it("charges gemini-3.1-pro-preview's over-200K rates above the threshold", () => {
    const pricing = getGeminiModelPricing("gemini-3.1-pro-preview");
    expect(inputRate(pricing, 199_000)).toBeCloseTo(2, 10);
    expect(inputRate(pricing, 250_000)).toBeCloseTo(4, 10);
    expect(cost(pricing, 250_000, MILLION)).toBeCloseTo((250_000 * 4) / MILLION + 18, 10);
  });

  it("leaves Flash cards flat, because Google publishes one row for them", () => {
    const pricing = getGeminiModelPricing("gemini-2.5-flash");
    expect(pricing?.usageTiers).toBeUndefined();
    expect(inputRate(pricing, 250_000)).toBeCloseTo(inputRate(pricing, 1_000), 10);
  });
});

/**
 * OpenAI publishes two rows for every 1.05M-context flagship: Standard rates
 * up to 272K input tokens, then 2x input/cache and 1.5x output for the whole
 * request above that. A card carrying only the headline underprices a 300K
 * prompt and prints without `~`, because every counter it was handed did have
 * a rate. Mini/nano and older GPT-5/4.1 cards stay a single row — a 400K or
 * 1M window is not the same as a published surcharge.
 */
describe("OpenAI long-context pricing", () => {
  const longContext = [
    { id: "gpt-6-astra", short: 10, long: 20, longOutput: 75 },
    { id: "gpt-5.6-sol", short: 4, long: 8, longOutput: 30 },
    { id: "gpt-5.6-terra", short: 2, long: 4, longOutput: 18 },
    { id: "gpt-5.6-luna", short: 0.2, long: 0.4, longOutput: 1.8 },
    { id: "gpt-5.5", short: 5, long: 10, longOutput: 45 },
    { id: "gpt-5.4", short: 2.5, long: 5, longOutput: 22.5 },
  ] as const;

  it.each(longContext)(
    "charges $id's over-272K rates above the threshold",
    ({ id, short, long, longOutput }) => {
      const pricing = getOpenAiModelPricing(id);
      expect(inputRate(pricing, 272_000)).toBeCloseTo(short, 10);
      expect(inputRate(pricing, 272_001)).toBeCloseTo(long, 10);
      expect(cost(pricing, 300_000, MILLION)).toBeCloseTo(
        (300_000 * long) / MILLION + longOutput,
        10
      );
    }
  );

  it.each(["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2", "gpt-5", "gpt-4.1"] as const)(
    "leaves %s flat, because OpenAI publishes one row for it",
    (id) => {
      const pricing = getOpenAiModelPricing(id);
      expect(pricing?.usageTiers).toBeUndefined();
      expect(inputRate(pricing, 300_000)).toBeCloseTo(inputRate(pricing, 1_000), 10);
    }
  );

  it("doubles the cache-write rate on the long row, as the published table does", () => {
    // gpt-5.5 publishes no cache-write row at all, so its write bills at the
    // ordinary input rate — which the long row doubles along with input.
    const long = (id: string) => getOpenAiModelPricing(id)?.usageTiers?.[1]?.pricing;
    expect(long("gpt-6-astra")?.cacheWrite).toBe(25);
    expect(long("gpt-5.6-sol")?.cacheWrite).toBe(10);
    expect(long("gpt-5.5")?.cacheWrite).toBe(10);
    expect(long("gpt-5.5")?.input).toBe(10);
  });

  it("states a derived long rate at the grain it is published at", () => {
    // 1.2 * 1.5 is 1.7999999999999998 and the published rate is $1.80. The
    // estimate rounds either way, but the card's own number reaches any UI that
    // renders the effective rate.
    expect(getOpenAiModelPricing("gpt-5.6-luna")?.usageTiers?.[1]?.pricing.output).toBe(1.8);
  });

  /**
   * A cold cache-checkpoint call bills its whole prefix as `cacheWrite`, and the
   * mapper subtracts those tokens out of `input` — so a card with no cacheWrite
   * rate does not merely print `~`, it prices the prefix at nothing.
   */
  it("prices a cold checkpoint's prefix on every flagship", () => {
    const coldCheckpoint: Usage = {
      input: 3,
      output: 100,
      cached: undefined,
      cacheWrite: 200_000,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    };
    for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-4o"]) {
      const estimate = estimateCost(coldCheckpoint, getOpenAiModelPricing(id));
      expect(estimate?.unpriced, `${id} left a counter unpriced`).toEqual([]);
      expect(estimate!.amount, `${id} priced the prefix at nothing`).toBeGreaterThan(0.01);
    }
  });
});

/**
 * Anthropic bills a long prompt at the card's standard rates: the 1M-context
 * models carry no long-context premium, and every other model in the table has
 * a 200K window, so no prompt could select a tier. The absence is deliberate —
 * this fails if one is added without published rates behind it.
 */
describe("Anthropic long-context pricing", () => {
  it("declares no usage tier on any card", () => {
    for (const [id, card] of Object.entries(ANTHROPIC_PRICING)) {
      expect(card.usageTiers, `${id} declares a usage tier`).toBeUndefined();
    }
  });

  it("prices a 250K-token prompt at the same per-token rate as a small one", () => {
    const pricing = ANTHROPIC_PRICING["claude-sonnet-4-5"];
    expect(inputRate(pricing, 250_000)).toBeCloseTo(inputRate(pricing, 10_000), 10);
  });
});
