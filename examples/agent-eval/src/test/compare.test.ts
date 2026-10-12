/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrialRecord } from "../compare/harborJobs";
import { classifyTrial, labelArms, loadTrials } from "../compare/harborJobs";
import { buildReport, renderMarkdown } from "../compare/report";
import { mcnemarExactP, passAtK, wilsonInterval } from "../compare/stats";

describe("stats", () => {
  it("bounds a Wilson interval inside [0, 1]", () => {
    const all = wilsonInterval(5, 5);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.5);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it("computes unbiased pass@k", () => {
    expect(passAtK(5, 0, 1)).toBe(0);
    expect(passAtK(5, 5, 3)).toBe(1);
    expect(passAtK(4, 1, 1)).toBeCloseTo(0.25);
    expect(passAtK(4, 1, 2)).toBeCloseTo(0.5);
  });

  it("gives an exact two-sided McNemar p-value", () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
    expect(mcnemarExactP(5, 5)).toBe(1);
    // 8 discordant pairs all one way: 2 * 0.5^8.
    expect(mcnemarExactP(8, 0)).toBeCloseTo(2 / 256);
  });
});

describe("classifyTrial", () => {
  it("reads an API error reporting an over-long prompt as a context overflow", () => {
    expect(
      classifyTrial(0, "ApiError", "maximum context length exceeded", true, undefined).failure
    ).toBe("context-overflow");
    expect(
      classifyTrial(0, "ApiError", "rate limit: too many tokens per minute", true, undefined)
        .failure
    ).toBe("rate-limit");
  });

  it("believes a reward even after an agent timeout", () => {
    expect(classifyTrial(1, "AgentTimeoutError", "", true, undefined).status).toBe("pass");
  });

  it("calls an exception before the agent ran blocked", () => {
    expect(
      classifyTrial(undefined, "RuntimeError", "docker compose failed", false, undefined).status
    ).toBe("blocked");
  });

  it("names failure modes", () => {
    expect(classifyTrial(0, "AgentTimeoutError", "", true, undefined).failure).toBe(
      "agent-timeout"
    );
    expect(classifyTrial(0, undefined, undefined, true, undefined).failure).toBe("wrong-answer");
    const overflow = {
      outcome: "error",
      error: "prompt is too long: 210000 tokens > 200000 maximum",
      rounds: 40,
      retries: 0,
      tools: { calls: 0, errors: 0, byName: {} },
      finalHistoryChars: 0,
    };
    expect(classifyTrial(0, "NonZeroAgentExitCodeError", "exit 1", true, overflow).failure).toBe(
      "context-overflow"
    );
    expect(
      classifyTrial(0, undefined, undefined, true, {
        ...overflow,
        outcome: "max-rounds",
        error: undefined,
      }).failure
    ).toBe("max-rounds");
    expect(classifyTrial(0, "ApiRateLimitError", "429", true, undefined).failure).toBe(
      "rate-limit"
    );
  });

  it("reads a Workglow provider failure from its own error, not the exit code", () => {
    const failed = (error: string): any => ({ ...base, outcome: "error", error });
    const base = {
      rounds: 3,
      retries: 2,
      tools: { calls: 0, errors: 0, byName: {} },
      finalHistoryChars: 0,
    };
    const exit = "NonZeroAgentExitCodeError";
    expect(classifyTrial(0, exit, "exit 1", true, failed("429 Too Many Requests")).failure).toBe(
      "rate-limit"
    );
    expect(classifyTrial(0, exit, "exit 1", true, failed("503 Service Unavailable")).failure).toBe(
      "provider-error"
    );
    expect(classifyTrial(0, exit, "exit 1", true, failed("fetch failed")).failure).toBe(
      "provider-error"
    );
    expect(
      classifyTrial(0, exit, "exit 1", true, failed("TypeError: x is undefined")).failure
    ).toBe("agent-crash");
  });
});

function trial(
  task: string,
  agent: string,
  pass: boolean,
  extra: Partial<TrialRecord> = {}
): TrialRecord {
  return {
    job: "job",
    trial: `${task}-${agent}-${Math.random()}`,
    task,
    arm: agent,
    kwargs: {},
    agent,
    agentVersion: "1",
    model: "anthropic/m",
    reward: pass ? 1 : 0,
    status: pass ? "pass" : "fail",
    failure: pass ? undefined : "wrong-answer",
    exceptionType: undefined,
    exceptionMessage: undefined,
    inputTokens: 100,
    cacheTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    agentSec: 30,
    setupSec: 5,
    workglow: undefined,
    ...extra,
  };
}

describe("labelArms", () => {
  it("shows only the kwargs that differ between configs of one agent", () => {
    const labelled = labelArms([
      trial("t", "workglow", true, { kwargs: { max_rounds: 100, effort: "high" } }),
      trial("t", "workglow", true, {
        kwargs: { max_rounds: 100, effort: "high", tool_concurrency: 8 },
      }),
      trial("t", "pi", true, { kwargs: { max_turns: 100, thinking: "high" } }),
    ]);
    expect(labelled.map((t) => t.arm)).toEqual(["workglow", "workglow[tool_concurrency=8]", "pi"]);
  });

  it("never gives two different settings one label", () => {
    const labelled = labelArms([
      trial("t", "workglow", true, {
        kwargs: { append_system_prompt: "hello,tool_concurrency=8" },
      }),
      trial("t", "workglow", true, {
        kwargs: { append_system_prompt: "hello", tool_concurrency: 8 },
      }),
      trial("t", "workglow", true, { kwargs: { append_system_prompt: "8" } }),
      trial("t", "workglow", true, { kwargs: { append_system_prompt: 8 } }),
    ]);
    expect(new Set(labelled.map((t) => t.arm)).size).toBe(4);
    expect(labelled[1]!.arm).toBe("workglow[append_system_prompt=hello,tool_concurrency=8]");
  });

  it("keeps two agent builds apart", () => {
    const labelled = labelArms([
      trial("t", "workglow", true, { kwargs: { bundle_path: "/a/workglow-agent.mjs" } }),
      trial("t", "workglow", false, { kwargs: { bundle_path: "/b/workglow-agent.mjs" } }),
      trial("t", "opencode", true, { kwargs: { version: "2.0.0" } }),
      trial("t", "opencode", true, { kwargs: { version: "2.1.0" } }),
    ]);
    expect(new Set(labelled.map((t) => t.arm)).size).toBe(4);
  });

  it("keeps a trial whose model is unknown in its agent's arm", () => {
    const labelled = labelArms([
      trial("t", "pi", true),
      trial("u", "pi", false, { model: undefined }),
      trial("t", "opencode", true, { model: "openai/x" }),
    ]);
    expect(labelled.map((t) => t.arm)).toEqual([
      "pi@anthropic/m",
      "pi@anthropic/m",
      "opencode@openai/x",
    ]);
  });

  it("adds the model when the comparison spans models", () => {
    const labelled = labelArms([
      trial("t", "pi", true),
      trial("t", "pi", true, { model: "openai/x" }),
    ]);
    expect(labelled.map((t) => t.arm)).toEqual(["pi@anthropic/m", "pi@openai/x"]);
  });
});

describe("buildReport", () => {
  const trials = [
    trial("a", "workglow", true),
    trial("b", "workglow", false),
    trial("c", "workglow", false, { status: "blocked", failure: undefined, reward: undefined }),
    trial("a", "opencode", true),
    trial("b", "opencode", true),
    trial("c", "opencode", true),
  ];

  it("summarizes each arm with blocked trials kept out of the rate", () => {
    const report = buildReport(trials);
    const workglow = report.arms.find((arm) => arm.arm === "workglow")!;
    expect(workglow.blocked).toBe(1);
    expect(workglow.passRate).toBe(0.5);
    expect(workglow.costUsd).toBeCloseTo(0.02);
    expect(workglow.failures).toEqual({ "wrong-answer": 1 });
    expect(report.arms[0]!.arm).toBe("opencode");
  });

  it("reports no cost per pass when a trial went unpriced", () => {
    const report = buildReport([
      trial("a", "pi", true),
      trial("b", "pi", true, { costUsd: undefined }),
      trial("a", "opencode", true),
    ]);
    expect(report.arms.find((arm) => arm.arm === "pi")!.costPerPass).toBeUndefined();
    expect(report.arms.find((arm) => arm.arm === "opencode")!.costPerPass).toBeCloseTo(0.01);
  });

  it("shows no rate for an arm none of whose trials ran, and ranks it last", () => {
    const blocked = { status: "blocked" as const, failure: undefined, reward: undefined };
    const report = buildReport([
      trial("a", "pi", false),
      trial("a", "opencode", false, blocked),
      trial("b", "opencode", false, blocked),
    ]);
    expect(report.arms.map((arm) => arm.arm)).toEqual(["pi", "opencode"]);
    expect(report.arms[1]).toMatchObject({
      passRate: undefined,
      passRateCi: undefined,
      passAt1: undefined,
    });
    expect(renderMarkdown(report)).toMatch(
      /\| opencode \| anthropic\/m \| 2 \| 0 \| 2 \| — \| — \|/
    );
  });

  it("marks token totals that leave out trials which reported none", () => {
    const report = buildReport([
      trial("a", "pi", true),
      trial("b", "pi", true, { inputTokens: undefined }),
    ]);
    expect(report.arms[0]!.usageMissingTrials).toBe(1);
    expect(
      buildReport([trial("a", "pi", true, { cacheTokens: undefined })]).arms[0]!.usageMissingTrials
    ).toBe(1);
    expect(renderMarkdown(report)).toContain("† some trials reported no token counts");
  });

  it("pairs arms on the tasks both ran", () => {
    const pair = buildReport(trials).pairs[0]!;
    expect(pair.commonTasks).toBe(2);
    expect(pair.aBetter).toEqual(["b"]);
    expect(pair.bBetter).toEqual([]);
  });

  it("counts a tie short of every attempt apart from a task both arms always passed", () => {
    const pair = buildReport([
      trial("a", "workglow", true),
      trial("a", "workglow", true),
      trial("a", "opencode", true),
      trial("a", "opencode", true),
      trial("b", "workglow", true),
      trial("b", "workglow", false),
      trial("b", "opencode", false),
      trial("b", "opencode", true),
    ]).pairs[0]!;
    expect(pair.bothPass).toBe(1);
    expect(pair.partialTie).toBe(1);
    expect(pair.neither).toBe(0);
  });

  it("keeps an arm or a tool named __proto__ as data, touching no prototype", () => {
    const report = buildReport([
      trial("t", "__proto__", true),
      trial("t", "workglow", false, {
        workglow: {
          outcome: "answered",
          rounds: 1,
          retries: 0,
          tools: {
            calls: 1,
            errors: 1,
            byName: JSON.parse('{"__proto__":{"calls":1,"errors":1}}'),
          },
          maxHistoryChars: 10,
        } as any,
      }),
    ]);
    const parsed = JSON.parse(JSON.stringify(report));
    expect(Object.keys(parsed.tasks[0].cells).sort()).toEqual(["__proto__", "workglow"]);
    expect(({} as Record<string, unknown>).calls).toBeUndefined();
  });

  it("lists a task one arm has no result for, so the gap shows", () => {
    const markdown = renderMarkdown(
      buildReport([
        trial("both", "workglow", true),
        trial("both", "opencode", true),
        trial("only-one", "workglow", true),
      ])
    );
    expect(markdown).toMatch(/\| only-one \| · \| ✓ \|/);
    expect(markdown).not.toMatch(/\| both \|/);
  });

  it("renders the tables and the disagreements", () => {
    const markdown = renderMarkdown(buildReport(trials));
    expect(markdown).toContain("| opencode | anthropic/m |");
    expect(markdown).toContain("**opencode** better on: b");
    expect(markdown).toMatch(/\| b \| ✓ \| ✗ wrong-answer \|/);
  });
});

describe("loadTrials", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a trial that failed before it had any agent logs", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-eval-jobs-"));
    const trialDir = join(dir, "job-1", "hello-world__abc");
    mkdirSync(trialDir, { recursive: true });
    writeFileSync(join(dir, "job-1", "result.json"), JSON.stringify({ n_total_trials: 1 }));
    writeFileSync(
      join(trialDir, "result.json"),
      JSON.stringify({
        trial_name: "hello-world__abc",
        task_name: "harbor/hello-world",
        config: {
          agent: {
            name: "workglow",
            import_path: "workglow_agent:WorkglowAgent",
            model_name: "anthropic/m",
            kwargs: {},
          },
        },
        exception_info: { exception_type: "EnvironmentStartTimeoutError", exception_message: "" },
      })
    );
    const trials = loadTrials([dir]);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.status).toBe("blocked");
    // No agent_info yet: the configured model still names its arm.
    expect(trials[0]!.model).toBe("anthropic/m");
  });

  it("reads Harbor trial results from a jobs directory", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-eval-jobs-"));
    const trialDir = join(dir, "job-1", "hello-world__abc");
    mkdirSync(join(trialDir, "agent"), { recursive: true });
    writeFileSync(join(dir, "job-1", "result.json"), JSON.stringify({ n_total_trials: 1 }));
    writeFileSync(
      join(trialDir, "result.json"),
      JSON.stringify({
        trial_name: "hello-world__abc",
        task_name: "harbor/hello-world",
        config: {
          agent: { import_path: "workglow_agent:WorkglowAgent", kwargs: { max_rounds: 100 } },
        },
        agent_info: {
          name: "workglow",
          version: "0.1.0",
          model_info: { name: "m", provider: "anthropic" },
        },
        agent_result: {
          n_input_tokens: 3062,
          n_cache_tokens: 0,
          n_output_tokens: 72,
          cost_usd: 0.0068,
          metadata: {
            workglow: {
              outcome: "answered",
              rounds: 3,
              retries: 0,
              tools: { calls: 2, errors: 0, byName: { bash: { calls: 2, errors: 0 } } },
              finalHistoryChars: 755,
            },
          },
        },
        verifier_result: { rewards: { reward: 1 } },
        exception_info: null,
        agent_execution: {
          started_at: "2026-10-06T17:59:41Z",
          finished_at: "2026-10-06T17:59:43Z",
        },
      })
    );
    const [record] = loadTrials([dir]);
    expect(record).toMatchObject({
      job: "job-1",
      task: "harbor/hello-world",
      arm: "workglow",
      model: "anthropic/m",
      status: "pass",
      inputTokens: 3062,
      agentSec: 2,
    });
    expect(record!.workglow?.rounds).toBe(3);
  });

  it("adds opencode's reasoning tokens to its output, as the other harnesses report them", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-eval-jobs-"));
    const trialDir = join(dir, "job-2", "regex-log__xyz");
    mkdirSync(join(trialDir, "agent"), { recursive: true });
    writeFileSync(
      join(trialDir, "result.json"),
      JSON.stringify({
        trial_name: "regex-log__xyz",
        task_name: "regex-log",
        agent_info: { name: "opencode", model_info: { name: "m", provider: "deepseek" } },
        agent_result: { n_input_tokens: 100, n_output_tokens: 40, cost_usd: 0.01 },
        verifier_result: { rewards: { reward: 1 } },
        agent_execution: {
          started_at: "2026-10-07T00:00:00Z",
          finished_at: "2026-10-07T00:00:05Z",
        },
      })
    );
    writeFileSync(
      join(trialDir, "agent", "opencode.txt"),
      [
        JSON.stringify({ type: "step_start" }),
        JSON.stringify({ type: "step_finish", part: { tokens: { output: 10, reasoning: 25 } } }),
        "not json",
        JSON.stringify({ type: "step_finish", part: { tokens: { output: 30, reasoning: 5 } } }),
      ].join("\n")
    );
    expect(loadTrials([dir])[0]!.outputTokens).toBe(70);
  });
});
