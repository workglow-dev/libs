/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentStep, ChatMessage } from "@workglow/ai";
import { describe, expect, it } from "vitest";
import { toAtifTrajectory } from "../agent/atif";
import type { AgentRunSummary } from "../agent/runSummary";
import { summarizeUsage, tallyTools } from "../agent/runSummary";

describe("toAtifTrajectory", () => {
  it("counts image tokens in a step's prompt and cached figures, as the totals do", () => {
    const steps: AgentStep[] = [
      {
        round: 1,
        startedAt: "2026-10-11T00:00:00.000Z",
        modelMs: 10,
        durationMs: 10,
        attempts: 1,
        text: "done",
        tools: [],
        usage: {
          input: 100,
          imageInput: 40,
          cached: 20,
          imageCached: 5,
          cacheWrite: 3,
          output: 7,
          reasoning: undefined,
          total: undefined,
          extra: undefined,
        },
        costUsd: undefined,
      },
    ];
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const usage = summarizeUsage(steps);
    const summary = { model: "m", usage, costUsd: undefined } as unknown as AgentRunSummary;

    const trajectory = toAtifTrajectory("s", "0.1.0", messages, steps, summary);

    expect(trajectory.steps[1]?.metrics).toEqual({
      prompt_tokens: 168,
      completion_tokens: 7,
      cached_tokens: 25,
      cost_usd: null,
    });
    expect(trajectory.steps[1]?.metrics?.prompt_tokens).toBe(
      trajectory.final_metrics.total_prompt_tokens
    );
    expect(trajectory.steps[1]?.metrics?.cached_tokens).toBe(
      trajectory.final_metrics.total_cached_tokens
    );
  });
});

describe("toAtifTrajectory metrics", () => {
  it("gives a round that reported only a cost no token metrics", () => {
    const steps = [
      {
        round: 1,
        startedAt: "2026-10-11T00:00:00.000Z",
        modelMs: 1,
        durationMs: 1,
        attempts: 1,
        text: "done",
        tools: [],
        usage: { costUsd: 0.01 },
        costUsd: 0.01,
      },
    ] as unknown as AgentStep[];
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const summary = {
      model: "m",
      usage: summarizeUsage(steps),
      costUsd: 0.01,
    } as unknown as AgentRunSummary;
    const trajectory = toAtifTrajectory("s", "0.1.0", messages, steps, summary);
    expect(trajectory.steps[1]).not.toHaveProperty("metrics");
  });
});

describe("summarizeUsage", () => {
  it("counts a round whose usage carries no token count as unreported, not as zero", () => {
    const steps = [
      { usage: { input: 10, output: 2 } },
      { usage: { costUsd: 0.01 } },
      { usage: undefined },
    ] as unknown as AgentStep[];
    const usage = summarizeUsage(steps);
    expect(usage.unreportedRounds).toBe(2);
    expect(usage.inputTokens).toBe(10);
  });
});

describe("summarizeUsage cache counts", () => {
  it("counts a round with tokens but no cache figure as cache-unreported, not as zero", () => {
    const steps = [
      { usage: { input: 10, output: 2, cached: 4 } },
      { usage: { input: 10, output: 2 } },
    ] as unknown as AgentStep[];
    const usage = summarizeUsage(steps);
    expect(usage.unreportedRounds).toBe(0);
    expect(usage.cacheUnreportedRounds).toBe(1);
    const summary = { model: "m", usage, costUsd: undefined } as unknown as AgentRunSummary;
    expect(toAtifTrajectory("s", "0.1.0", [], [], summary).final_metrics.total_cached_tokens).toBe(
      null
    );
  });
});

describe("tallyTools", () => {
  it("counts a tool named after an Object.prototype key without touching the prototype", () => {
    const steps = [
      {
        tools: [
          { name: "__proto__", isError: true },
          { name: "constructor", isError: false },
        ],
      },
    ] as unknown as AgentStep[];
    const tally = tallyTools(steps);
    expect(tally.byName["__proto__"]).toEqual({ calls: 1, errors: 1 });
    expect(tally.byName["constructor"]).toEqual({ calls: 1, errors: 0 });
    expect(({} as Record<string, unknown>).calls).toBeUndefined();
    expect(JSON.parse(JSON.stringify(tally)).byName.constructor).toEqual({ calls: 1, errors: 0 });
  });
});
