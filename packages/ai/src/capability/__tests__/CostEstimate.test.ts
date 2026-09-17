/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../../model/ModelSchema";
import { estimateCost, sumCostEstimates } from "../CostEstimate";

const pricing: ModelPricing = {
  currency: "USD",
  input: 3,
  output: 15,
  cached: 0.3,
  cacheWrite: 3.75,
  cacheStoragePerHour: undefined,
};

const usage = (over: Partial<Usage>): Usage => ({
  input: undefined,
  output: undefined,
  cached: undefined,
  cacheWrite: undefined,
  reasoning: undefined,
  total: undefined,
  extra: undefined,
  ...over,
});

describe("estimateCost", () => {
  it("sums disjoint buckets without subtracting", () => {
    const estimate = estimateCost(
      usage({ input: 1_000_000, output: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000 }),
      pricing
    );
    expect(estimate?.amount).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
    expect(estimate?.unpriced).toEqual([]);
    expect(estimate?.stated).toBe(false);
  });

  it("prices imageInput and imageCached as their own buckets", () => {
    const imagePricing: ModelPricing = {
      currency: "USD",
      input: 5,
      output: 30,
      cached: 1.25,
      imageInput: 8,
      imageCached: 2,
    };
    const estimate = estimateCost(
      usage({
        input: 1_000_000,
        output: 1_000_000,
        cached: 1_000_000,
        imageInput: 1_000_000,
        imageCached: 1_000_000,
      }),
      imagePricing
    );
    expect(estimate?.amount).toBeCloseTo(5 + 30 + 1.25 + 8 + 2, 10);
    expect(estimate?.unpriced).toEqual([]);
  });

  it("names imageInput as unpriced when spent without a rate", () => {
    const estimate = estimateCost(usage({ input: 1_000_000, imageInput: 500_000 }), pricing);
    expect(estimate?.amount).toBeCloseTo(3, 10);
    expect(estimate?.unpriced).toEqual(["imageInput"]);
  });

  it("never prices reasoning or total, and never lists them as unpriced", () => {
    // reasoning is inside output and total covers everything; pricing either
    // would count the same tokens twice.
    const estimate = estimateCost(
      usage({ output: 1_000_000, reasoning: 500_000, total: 2_000_000 }),
      pricing
    );
    expect(estimate?.amount).toBeCloseTo(15, 10);
    expect(estimate?.unpriced).toEqual([]);
  });

  it("names counters that were spent but have no declared rate", () => {
    const noCacheRates: ModelPricing = { ...pricing, cached: undefined, cacheWrite: undefined };
    const estimate = estimateCost(usage({ input: 1_000_000, cached: 500_000 }), noCacheRates);
    expect(estimate?.amount).toBeCloseTo(3, 10);
    expect(estimate?.unpriced).toEqual(["cached"]);
  });

  it("prefers a provider-stated cost over local arithmetic", () => {
    const estimate = estimateCost(usage({ input: 1_000_000, extra: { cost: 0.00042 } }), pricing);
    expect(estimate?.amount).toBe(0.00042);
    expect(estimate?.stated).toBe(true);
  });

  it("returns undefined rather than zero when it cannot price", () => {
    expect(estimateCost(usage({ input: 100 }), undefined)).toBe(undefined);
    expect(estimateCost(usage({}), pricing)).toBe(undefined);
  });

  it("prices cache storage from token-hours in extra", () => {
    // Every token rate absent, so only `cacheStoragePerHour` can make this
    // priced at all — a zero rate would price it either way.
    const storage: ModelPricing = {
      currency: "USD",
      input: undefined,
      output: undefined,
      cached: undefined,
      cacheWrite: undefined,
      cacheStoragePerHour: 1,
    };
    const estimate = estimateCost(usage({ extra: { cacheStorageTokenHours: 2_000_000 } }), storage);
    expect(estimate?.amount).toBeCloseTo(2, 10);
  });

  it("prices cacheWrite from split cacheWrite5m or cacheWrite1h object", () => {
    const splitPricing: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      cached: 0.3,
      cacheWrite: {
        cacheWrite5m: 3.75,
        cacheWrite1h: 6,
      },
      cacheStoragePerHour: undefined,
    };
    const estimate = estimateCost(
      usage({ input: 1_000_000, output: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000 }),
      splitPricing
    );
    expect(estimate?.amount).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
    expect(estimate?.unpriced).toEqual([]);
  });
});

describe("estimateCost and pricing tiers", () => {
  const discounted: ModelPricing = {
    currency: "USD",
    input: 3,
    output: 15,
    cached: undefined,
    cacheWrite: undefined,
    cacheStoragePerHour: undefined,
    timingTiers: [{ start: "16:30", end: "00:30", pricing: { input: 1.5, output: 7.5 } }],
  };

  it("charges the timing tier's rates for a request inside the window", () => {
    const estimate = estimateCost(usage({ input: 1_000_000, output: 1_000_000 }), discounted, {
      at: new Date("2026-09-04T18:00:00Z"),
    });
    expect(estimate?.amount).toBeCloseTo(1.5 + 7.5, 10);
  });

  it("charges the base rates for the same request outside the window", () => {
    const estimate = estimateCost(usage({ input: 1_000_000, output: 1_000_000 }), discounted, {
      at: new Date("2026-09-04T12:00:00Z"),
    });
    expect(estimate?.amount).toBeCloseTo(3 + 15, 10);
  });

  it("selects a usage tier from the whole prompt, cache reads included", () => {
    const tiered: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      cached: 0.3,
      cacheWrite: undefined,
      cacheStoragePerHour: undefined,
      usageTiers: [
        { maxInputTokens: 200_000, pricing: { input: 3, cached: 0.3 } },
        { minInputTokens: 200_000, pricing: { input: 6, cached: 0.6 } },
      ],
    };
    // 150K plain + 100K cache reads is a 250K prompt, so the surcharge applies
    // even though the plain-input counter alone is under the threshold.
    const estimate = estimateCost(usage({ input: 150_000, cached: 100_000 }), tiered);
    expect(estimate?.amount).toBeCloseTo((150_000 * 6 + 100_000 * 0.6) / 1_000_000, 10);
  });

  it("selects a usage tier from the whole prompt, image tokens included", () => {
    const tiered: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      cached: undefined,
      cacheWrite: undefined,
      cacheStoragePerHour: undefined,
      imageInput: 8,
      usageTiers: [
        { maxInputTokens: 200_000, pricing: { input: 3, imageInput: 8 } },
        { minInputTokens: 200_000, pricing: { input: 6, imageInput: 16 } },
      ],
    };
    const estimate = estimateCost(usage({ input: 150_000, imageInput: 100_000 }), tiered);
    expect(estimate?.amount).toBeCloseTo((150_000 * 6 + 100_000 * 16) / 1_000_000, 10);
  });

  it("reports a counter as unpriced when the tier that applies drops its rate", () => {
    const dropsCache: ModelPricing = {
      currency: "USD",
      input: 3,
      output: undefined,
      cached: undefined,
      cacheWrite: undefined,
      cacheStoragePerHour: undefined,
      timingTiers: [{ start: "00:00", end: "12:00", pricing: { input: 1.5 } }],
    };
    const estimate = estimateCost(usage({ input: 1_000_000, cached: 500_000 }), dropsCache, {
      at: new Date("2026-09-04T06:00:00Z"),
    });
    expect(estimate?.amount).toBeCloseTo(1.5, 10);
    expect(estimate?.unpriced).toEqual(["cached"]);
  });

  it("still prefers a provider-stated cost over any tier", () => {
    const estimate = estimateCost(
      usage({ input: 1_000_000, extra: { cost: 0.00042 } }),
      discounted,
      { at: new Date("2026-09-04T18:00:00Z") }
    );
    expect(estimate?.amount).toBe(0.00042);
    expect(estimate?.stated).toBe(true);
  });
});

describe("sumCostEstimates", () => {
  it("returns undefined for an empty list", () => {
    expect(sumCostEstimates([])).toBe(undefined);
  });

  it("sums amounts and unions unpriced fields", () => {
    const sum = sumCostEstimates([
      { currency: "USD", amount: 0.01, unpriced: ["cached"], stated: false },
      { currency: "USD", amount: 0.02, unpriced: [], stated: true },
    ]);
    expect(sum).toEqual({
      currency: "USD",
      amount: 0.03,
      unpriced: ["cached"],
      stated: false,
    });
  });

  it("refuses to mix currencies", () => {
    expect(
      sumCostEstimates([
        { currency: "USD", amount: 0.01, unpriced: [], stated: true },
        { currency: "EUR", amount: 0.02, unpriced: [], stated: true },
      ])
    ).toBe(undefined);
  });
});

describe("estimateCost and heuristic counters", () => {
  it("prices nothing when the counters are character-count estimates", () => {
    // Multiplying a guessed token count by a real rate produces a dollar figure
    // that reads exactly like a billed one, and nothing downstream can tell them
    // apart afterwards.
    expect(estimateCost(usage({ input: 100, output: 20, estimated: true }), pricing)).toBe(
      undefined
    );
  });

  it("still prices the same counters when they are stated", () => {
    // Scope guard: the refusal keys on the flag, not on the counters.
    expect(estimateCost(usage({ input: 100, output: 20 }), pricing)?.amount).toBeGreaterThan(0);
  });

  it("does not price an estimate even with a provider-stated cost attached", () => {
    // `extra.cost` normally wins outright. A run whose token counts are guesses
    // has no business asserting a stated total either.
    expect(
      estimateCost(
        usage({ input: 100, output: 20, extra: { cost: 0.5 }, estimated: true }),
        pricing
      )
    ).toBe(undefined);
  });
});
