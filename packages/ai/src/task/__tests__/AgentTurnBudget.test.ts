/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { TaskConfigurationError } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../../model/ModelPricing";
import type { AgentBudgetLimits } from "../AgentTurnBudget";
import { AgentTurnBudget } from "../AgentTurnBudget";

/** $1 per million uncached input tokens, $2 output. */
const PRICING: ModelPricing = { currency: "USD", input: 1, output: 2 };
const AT = new Date("2026-01-01T00:00:00Z");

const NO_LIMITS: AgentBudgetLimits = {
  maxInputTokens: undefined,
  maxCostUsd: undefined,
  maxDurationMs: undefined,
};

function usage(input: number | undefined, output: number | undefined): Usage {
  return {
    input,
    output,
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  };
}

function charge(budget: AgentTurnBudget, spent: Usage | undefined): void {
  budget.record(spent, budget.price(spent, AT));
}

describe("AgentTurnBudget", () => {
  it("never runs out with no caps, whatever the rounds report", () => {
    const budget = new AgentTurnBudget(NO_LIMITS, undefined);
    charge(budget, undefined);
    charge(budget, usage(1_000_000, 10));
    expect(budget.exhausted()).toBe(false);
    expect(budget.mustStopLoop()).toBe(false);
    expect(budget.timeExhausted()).toBe(false);
    expect(budget.deadline).toBeUndefined();
  });

  describe("maxInputTokens", () => {
    const limits: AgentBudgetLimits = { ...NO_LIMITS, maxInputTokens: 1_500 };

    it("binds once the rounds' prompt tokens reach it", () => {
      const budget = new AgentTurnBudget(limits, undefined);
      charge(budget, usage(1_000, 10));
      expect(budget.exhausted()).toBe(false);
      charge(budget, usage(500, 10));
      expect(budget.exhausted()).toBe(true);
      expect(budget.mustStopLoop()).toBe(true);
    });

    it("counts an estimate like a stated figure", () => {
      const budget = new AgentTurnBudget(limits, undefined);
      charge(budget, { ...usage(1_000, 10), estimated: true });
      expect(budget.exhausted()).toBe(false);
      charge(budget, { ...usage(1_000, 10), estimated: true });
      expect(budget.exhausted()).toBe(true);
    });

    it("stops the loop after a round that reported no usage, without calling the cap spent", () => {
      const budget = new AgentTurnBudget(limits, undefined);
      charge(budget, undefined);
      expect(budget.mustStopLoop()).toBe(true);
      expect(budget.exhausted()).toBe(false);
    });

    it("stops the loop after a round that counted only its output", () => {
      const budget = new AgentTurnBudget(limits, undefined);
      charge(budget, usage(undefined, 10));
      expect(budget.mustStopLoop()).toBe(true);
      expect(budget.exhausted()).toBe(false);
    });
  });

  describe("maxCostUsd", () => {
    const limits: AgentBudgetLimits = { ...NO_LIMITS, maxCostUsd: 0.0025 };

    it("is refused without a price card to measure it by", () => {
      expect(() => new AgentTurnBudget(limits, undefined)).toThrow(TaskConfigurationError);
    });

    it("binds once the rounds' priced spend reaches it, and totals that spend", () => {
      const budget = new AgentTurnBudget(limits, PRICING);
      expect(budget.costUsd()).toBeUndefined();
      // 1,000 × $1 + 10 × $2, per million: $0.00102 a round.
      charge(budget, usage(1_000, 10));
      charge(budget, usage(1_000, 10));
      expect(budget.exhausted()).toBe(false);
      expect(budget.costUsd()).toBeCloseTo(0.00204, 10);
      charge(budget, usage(1_000, 10));
      expect(budget.exhausted()).toBe(true);
    });

    it("stops the loop after a round it cannot price, and reports no total", () => {
      const budget = new AgentTurnBudget(limits, PRICING);
      charge(budget, usage(1_000, 10));
      charge(budget, { ...usage(10, 1), estimated: true });
      expect(budget.price({ ...usage(10, 1), estimated: true }, AT)).toBeUndefined();
      expect(budget.mustStopLoop()).toBe(true);
      expect(budget.exhausted()).toBe(false);
      expect(budget.costUsd()).toBeUndefined();
    });

    it("leaves an unmeasured round alone when no cap asks for that measure", () => {
      const tokensOnly = new AgentTurnBudget({ ...NO_LIMITS, maxInputTokens: 1_000_000 }, PRICING);
      charge(tokensOnly, { ...usage(10, 1), estimated: true });
      expect(tokensOnly.mustStopLoop()).toBe(false);
    });
  });

  describe("maxDurationMs", () => {
    it("sets a deadline from when the turn started, and is out of time at it", () => {
      const budget = new AgentTurnBudget({ ...NO_LIMITS, maxDurationMs: 100 }, undefined, 1_000);
      expect(budget.deadline).toBe(1_100);
      expect(budget.timeExhausted(1_099)).toBe(false);
      expect(budget.timeExhausted(1_100)).toBe(true);
    });

    it("leaves the token and cost caps to their own predicates", () => {
      const budget = new AgentTurnBudget({ ...NO_LIMITS, maxDurationMs: 1 }, undefined, 0);
      expect(budget.timeExhausted()).toBe(true);
      expect(budget.exhausted()).toBe(false);
      expect(budget.mustStopLoop()).toBe(false);
    });
  });
});
