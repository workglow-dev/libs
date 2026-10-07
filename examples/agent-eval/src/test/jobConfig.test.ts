/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { parseEffort, resolveAgentModel } from "../agent/models";
import { buildHarborJob, parityKwargs, parseArm } from "../run/jobConfig";
import { getSuite } from "../run/suites";

const parity = {
  maxTurns: 50,
  effort: "high" as const,
  opencodeVariant: "high",
  piModelApi: undefined,
};

describe("parseArm", () => {
  it("parses a bare harness and one with kwargs", () => {
    expect(parseArm("pi")).toEqual({ harness: "pi", kwargs: {} });
    expect(parseArm("workglow:tool_concurrency=8,append_system_prompt=be brief")).toEqual({
      harness: "workglow",
      kwargs: { tool_concurrency: 8, append_system_prompt: "be brief" },
    });
  });

  it("refuses an unknown harness", () => {
    expect(() => parseArm("aider")).toThrow(/unknown harness/);
  });
});

describe("parityKwargs", () => {
  it("holds every harness to the same turn cap and reasoning level", () => {
    expect(parityKwargs("workglow", parity)).toEqual({ max_rounds: 50, effort: "high" });
    expect(parityKwargs("pi", parity)).toEqual({ max_turns: 50, thinking: "high" });
    expect(parityKwargs("opencode", parity)).toEqual({
      opencode_config: { agent: { build: { steps: 50 } } },
      variant: "high",
    });
  });
});

describe("buildHarborJob", () => {
  it("puts every arm in one job, letting an arm's own kwargs win", () => {
    const job = buildHarborJob({
      jobName: "j",
      jobsDir: "./jobs",
      model: "anthropic/claude-sonnet-5-5",
      arms: [parseArm("workglow"), parseArm("workglow:max_rounds=10"), parseArm("opencode")],
      datasets: getSuite("smoke").datasets,
      parity,
      attempts: 3,
      concurrency: 2,
      timeoutMultiplier: undefined,
    });
    expect(job).toMatchObject({ job_name: "j", n_attempts: 3, n_concurrent_trials: 2 });
    // Only infrastructure failures are retried; an agent's own failure never is.
    expect(job.retry).toEqual({
      max_retries: 2,
      include_exceptions: [
        "RuntimeError",
        "EnvironmentStartTimeoutError",
        "AgentSetupTimeoutError",
      ],
    });
    const agents = job.agents as Array<Record<string, unknown>>;
    expect(agents[0]).toMatchObject({
      import_path: "workglow_agent:WorkglowAgent",
      kwargs: { max_rounds: 50 },
    });
    expect(agents[1]).toMatchObject({ kwargs: { max_rounds: 10 } });
    expect(agents[2]).toMatchObject({
      name: "opencode",
      model_name: "anthropic/claude-sonnet-5-5",
    });
    expect(job.datasets).toHaveLength(2);
  });
});

describe("resolveAgentModel", () => {
  it("maps provider prefixes the way the other harnesses spell them", () => {
    expect(resolveAgentModel("anthropic/claude-sonnet-5-5", { env: {} })).toMatchObject({
      provider: "ANTHROPIC",
      provider_config: { model_name: "claude-sonnet-5-5" },
    });
    expect(resolveAgentModel("google/gemini-3-pro", { env: {} }).provider).toBe("GOOGLE_GEMINI");
    expect(resolveAgentModel("openrouter/qwen/qwen3-coder", { env: {} })).toMatchObject({
      provider: "OPENROUTER",
      provider_config: { model_name: "qwen/qwen3-coder" },
    });
  });

  it("takes a custom endpoint from the provider's base URL variable", () => {
    expect(
      resolveAgentModel("anthropic/m", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } })
        .provider_config
    ).toMatchObject({ base_url: "http://127.0.0.1:9", trustedBaseUrl: true });
  });

  it("refuses an id without a provider", () => {
    expect(() => resolveAgentModel("claude-sonnet-5-5", { env: {} })).toThrow(/provider\/model/);
    expect(() => resolveAgentModel("mystery/m", { env: {} })).toThrow(/unsupported provider/);
  });
});

describe("parseEffort", () => {
  it("accepts pi's names for reasoning levels", () => {
    expect(parseEffort("off")).toBe("none");
    expect(parseEffort("xhigh")).toBe("extra");
    expect(parseEffort("high")).toBe("high");
    expect(parseEffort(undefined)).toBeUndefined();
    expect(() => parseEffort("turbo")).toThrow(/unknown effort/);
  });
});
