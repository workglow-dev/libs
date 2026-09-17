/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { CACHE_HIT_USAGE } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../../model/ModelSchema";
import { formatCost, formatUsage, formatUsageWithCost } from "../formatUsage";

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

describe("formatUsage", () => {
  it("renders nothing when no model reported", () => {
    expect(formatUsage(undefined, "directional")).toBe("");
    expect(formatUsage(undefined, "cumulative")).toBe("");
    expect(formatUsage(undefined, "detailed")).toBe("");
  });

  it("renders a stated all-zero usage as cached", () => {
    // A replayed output cost nothing; that is different from nothing running.
    expect(formatUsage(CACHE_HIT_USAGE, "directional")).toBe("cached");
    expect(formatUsage(CACHE_HIT_USAGE, "detailed")).toBe("cached");
  });

  it("still reads as cached when the optional image counters are absent", () => {
    // The image counters are optional, so a text-only constructor — every one
    // outside this repo included — states zeros without naming them. Requiring
    // them here turned a replay into `↑0 ↓0 cached 0 cache-write 0 …`.
    const textOnlyZero = usage({
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    });
    expect(formatUsage(textOnlyZero, "directional")).toBe("cached");
    expect(formatUsage(textOnlyZero, "cumulative")).toBe("cached");
    expect(formatUsage(textOnlyZero, "detailed")).toBe("cached");
  });

  it("splits both directions and groups thousands", () => {
    expect(formatUsage(usage({ input: 1240, output: 318 }), "directional")).toBe("↑1,240 ↓318");
  });

  it("shows cached inline only when the provider reported it", () => {
    // The arrow is the whole prompt, so the parenthetical reads as the portion
    // of it that was served from cache: 2,340 up, of which 1,100 were reads.
    expect(formatUsage(usage({ input: 1240, output: 318, cached: 1100 }), "directional")).toBe(
      "↑2,340 (1,100 cached) ↓318"
    );
  });

  it("names every reported counter in detailed mode", () => {
    const text = formatUsage(
      usage({ input: 10, output: 20, cached: 30, cacheWrite: 40, reasoning: 5, total: 100 }),
      "detailed"
    );
    expect(text).toContain("cached 30");
    expect(text).toContain("cache-write 40");
    expect(text).toContain("reasoning 5");
    expect(text).toContain("total 100");
  });

  it("drops the inline cached figure in cumulative mode", () => {
    // The web panel shows a running total, so it carries both directions but
    // not the per-call cache split the cli renders inline. Without this the two
    // levels could be swapped, or made identical, with nothing failing.
    const reported = usage({ input: 1240, output: 318, cached: 1100 });
    expect(formatUsage(reported, "cumulative")).toBe("↑2,340 ↓318");
    expect(formatUsage(reported, "directional")).toBe("↑2,340 (1,100 cached) ↓318");
  });

  it("counts the whole prompt in the arrow, not just the base-rate slice", () => {
    // input/cached/cacheWrite are disjoint slices of one prompt, so the arrow
    // has to sum them. These are the counts a warm cache-checkpoint call
    // actually reports; billing only the base-rate slice renders ↑3.
    const warm = usage({ input: 3, output: 318, cached: 11_000, cacheWrite: 236 });
    expect(formatUsage(warm, "cumulative")).toBe("↑11,239 ↓318");
    expect(formatUsage(warm, "directional")).toBe("↑11,239 (11,000 cached) ↓318");
  });

  it("leaves an unreported prompt unreported rather than summing to zero", () => {
    // No prompt counter stated at all is not a 0-token prompt.
    expect(formatUsage(usage({ output: 318 }), "cumulative")).toBe("↓318");
    expect(formatUsage(usage({ output: 318 }), "directional")).toBe("↓318");
  });

  it("renders a stated all-zero usage as cached at every detail level", () => {
    expect(formatUsage(CACHE_HIT_USAGE, "cumulative")).toBe("cached");
  });

  it("omits unreported counters rather than printing zeros", () => {
    const text = formatUsage(usage({ input: 10, output: 20 }), "detailed");
    expect(text).not.toContain("cached");
    expect(text).not.toContain("cache-write");
    expect(text).not.toContain("image");
  });

  it("counts image prompt tokens in the arrow and names the cached image slice", () => {
    expect(
      formatUsage(
        usage({ input: 100, imageInput: 400, imageCached: 50, output: 10 }),
        "directional"
      )
    ).toBe("↑550 (50 image cached) ↓10");
    expect(
      formatUsage(usage({ input: 100, cached: 20, imageCached: 50, output: 10 }), "directional")
    ).toBe("↑170 (20 cached, 50 image cached) ↓10");
  });

  it("names image counters in detailed mode", () => {
    const text = formatUsage(
      usage({ input: 10, output: 20, imageInput: 30, imageCached: 40 }),
      "detailed"
    );
    expect(text).toContain("image 30");
    expect(text).toContain("image-cached 40");
  });
});

describe("formatCost", () => {
  it("renders nothing when unpriceable", () => {
    expect(formatCost(undefined)).toBe("");
  });

  it("marks a partial estimate with a tilde", () => {
    expect(
      formatCost({ currency: "USD", amount: 0.0142, unpriced: ["cached"], stated: false })
    ).toBe("~$0.0142");
  });

  it("renders a complete estimate plainly", () => {
    expect(formatCost({ currency: "USD", amount: 0.0142, unpriced: [], stated: false })).toBe(
      "$0.0142"
    );
  });

  it("names a non-USD currency instead of assuming a dollar sign", () => {
    expect(formatCost({ currency: "EUR", amount: 0.0142, unpriced: [], stated: false })).toBe(
      "EUR 0.0142"
    );
  });

  it("keeps sub-cent OpenRouter charges visible instead of rounding to $0.0000", () => {
    expect(formatCost({ currency: "USD", amount: 0.000009774, unpriced: [], stated: true })).toBe(
      "$0.0000098"
    );
  });
});

const pricing: ModelPricing = {
  currency: "USD",
  input: 3,
  output: 15,
  cached: 0.3,
  cacheWrite: undefined,
  cacheStoragePerHour: undefined,
};

describe("formatUsageWithCost", () => {
  it("appends a priced figure when rates are known", () => {
    expect(
      formatUsageWithCost(usage({ input: 1_000_000, output: 1_000_000 }), "directional", pricing)
    ).toBe("↑1,000,000 ↓1,000,000 $18.0000");
  });

  it("stays tokens-only when nothing can be priced", () => {
    expect(formatUsageWithCost(usage({ input: 100, output: 20 }), "directional", undefined)).toBe(
      "↑100 ↓20"
    );
  });

  it("keeps a cache-hit label free of a dollar amount", () => {
    expect(formatUsageWithCost(CACHE_HIT_USAGE, "directional", pricing)).toBe("cached");
  });

  it("surfaces a provider-stated cost without a rate card", () => {
    expect(
      formatUsageWithCost(
        usage({ input: 100, output: 20, extra: { cost: 0.00042 } }),
        "directional",
        undefined
      )
    ).toBe("↑100 ↓20 $0.0004");
  });

  it("marks heuristic counters and shows no cost", () => {
    // The counters are still worth showing — that live ↑↓ movement is why the
    // estimate exists — but a reader must not take them for what was billed,
    // and a dollar amount derived from them would say exactly that.
    expect(
      formatUsageWithCost(
        usage({ input: 100, output: 20, estimated: true }),
        "directional",
        pricing
      )
    ).toBe("~↑100 ↓20");
  });

  // A row on screen is re-rendered constantly, so pricing it against the render
  // clock means a finished request's cost changes as the clock crosses a
  // discount window — the same tokens, two different totals. The window here is
  // built from the current time so the test cannot pass by accident whichever
  // hour it runs in: `at` is inside it and "now" is an hour past its end.
  describe("time-of-day rates", () => {
    const HOUR_MS = 3_600_000;
    const now = Date.now();
    const requestedAt = new Date(now - 2 * HOUR_MS);

    const utcClock = (ms: number): string => {
      const at = new Date(ms);
      const hh = String(at.getUTCHours()).padStart(2, "0");
      const mm = String(at.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    };

    const discounted: ModelPricing = {
      ...pricing,
      timingTiers: [
        {
          start: utcClock(now - 3 * HOUR_MS),
          end: utcClock(now - HOUR_MS),
          pricing: { input: 1.5, output: 7.5 },
        },
      ],
    };

    const spend = usage({ input: 1_000_000, output: 1_000_000 });

    it("prices at the instant the request ran when one is given", () => {
      expect(formatUsageWithCost(spend, "cumulative", discounted, { at: requestedAt })).toBe(
        "↑1,000,000 ↓1,000,000 $9.0000"
      );
    });

    it("accepts the instant as epoch milliseconds", () => {
      expect(
        formatUsageWithCost(spend, "cumulative", discounted, { at: requestedAt.getTime() })
      ).toBe("↑1,000,000 ↓1,000,000 $9.0000");
    });

    it("falls back to the current clock when no instant is given", () => {
      expect(formatUsageWithCost(spend, "cumulative", discounted)).toBe(
        "↑1,000,000 ↓1,000,000 $18.0000"
      );
    });
  });
});
