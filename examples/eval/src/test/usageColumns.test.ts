/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import type { Usage } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import { usageColumns } from "../evals/runner";
import { EvalResultSchema } from "../storage";

describe("eval usage columns", () => {
  it("declares every counter as nullable and none as required", () => {
    for (const column of [
      "input_tokens",
      "output_tokens",
      "cached_tokens",
      "cache_write_tokens",
      "image_input_tokens",
      "image_cached_tokens",
      "total_tokens",
      "cost",
      "currency",
    ]) {
      expect(EvalResultSchema.properties).toHaveProperty(column);
      expect(EvalResultSchema.required).not.toContain(column);
    }
  });

  it("stores an unreported counter as null rather than 0", () => {
    const columns = usageColumns(
      {
        input: 10,
        output: 2,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
        extra: undefined,
      },
      undefined,
      undefined
    );
    expect(columns.input_tokens).toBe(10);
    expect(columns.cached_tokens).toBe(null);
    expect(columns.cost).toBe(null);
  });

  it("stores all-null columns when the model reported nothing", () => {
    const columns = usageColumns(undefined, undefined, undefined);
    expect(columns.input_tokens).toBe(null);
    expect(columns.output_tokens).toBe(null);
  });

  // A sweep row is priced once and stored, and DeepSeek's off-peak window is a
  // 2x swing — so a batch that ran before the window must not be written at the
  // discount because the write happened after it opened. The window below is
  // derived from the current time so the test cannot pass by accident whichever
  // hour it runs in: the request's instant is inside it, "now" is an hour past.
  describe("time-of-day rates", () => {
    const HOUR_MS = 3_600_000;
    const now = Date.now();

    const utcClock = (ms: number): string => {
      const at = new Date(ms);
      const hh = String(at.getUTCHours()).padStart(2, "0");
      const mm = String(at.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    };

    const pricing: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      cached: undefined,
      cacheWrite: undefined,
      cacheStoragePerHour: undefined,
      timingTiers: [
        {
          start: utcClock(now - 3 * HOUR_MS),
          end: utcClock(now - HOUR_MS),
          pricing: { input: 1.5, output: 7.5 },
        },
      ],
    };

    const spend: Usage = {
      input: 1_000_000,
      output: 1_000_000,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    };

    it("prices a row at the instant its request ran", () => {
      const columns = usageColumns(spend, pricing, new Date(now - 2 * HOUR_MS));
      expect(columns.cost).toBeCloseTo(9, 10);
    });

    it("prices at the current clock only when the instant is unknown", () => {
      expect(usageColumns(spend, pricing, undefined).cost).toBeCloseTo(18, 10);
    });
  });
});
