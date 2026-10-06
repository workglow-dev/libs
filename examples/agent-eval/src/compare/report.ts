/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FailureMode, TrialRecord } from "./harborJobs";
import type { Interval } from "./stats";
import { mcnemarExactP, mean, median, passAtK, wilsonInterval } from "./stats";

export interface ArmSummary {
  readonly arm: string;
  readonly models: readonly string[];
  readonly versions: readonly string[];
  readonly tasks: number;
  readonly trials: number;
  /** Trials the infrastructure lost before the agent ran; excluded from every rate. */
  readonly blocked: number;
  readonly passed: number;
  /** Passes over trials that ran. */
  readonly passRate: number;
  readonly passRateCi: Interval;
  /** Mean over tasks of the task's pass fraction: pass@1, unbiased with several attempts. */
  readonly passAt1: number;
  /** pass@k at the largest k every task in this arm has attempts for, when above 1. */
  readonly passAtK: { readonly k: number; readonly value: number } | undefined;
  readonly costUsd: number | undefined;
  readonly costPerPass: number | undefined;
  /** Trials that reported no cost; a total over the rest would understate. */
  readonly unpricedTrials: number;
  readonly inputTokens: number;
  readonly cacheTokens: number;
  readonly outputTokens: number;
  readonly medianAgentSec: number | undefined;
  readonly failures: Readonly<Partial<Record<FailureMode, number>>>;
  readonly workglow: WorkglowArmDetail | undefined;
}

export interface WorkglowArmDetail {
  readonly outcomes: Readonly<Record<string, number>>;
  readonly meanRounds: number | undefined;
  readonly retries: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly byTool: Readonly<Record<string, { calls: number; errors: number }>>;
  readonly maxHistoryChars: number;
}

export interface PairComparison {
  readonly a: string;
  readonly b: string;
  readonly commonTasks: number;
  readonly bothPass: number;
  readonly neither: number;
  /** Tasks where `a`'s pass fraction is higher. */
  readonly aBetter: readonly string[];
  readonly bBetter: readonly string[];
  /** Exact sign / McNemar p-value over the tasks where the arms differ. */
  readonly pValue: number;
}

export interface TaskCell {
  readonly passes: number;
  readonly runs: number;
  readonly blocked: number;
  readonly failures: readonly FailureMode[];
}

export interface ComparisonReport {
  readonly generatedAt: string;
  readonly arms: readonly ArmSummary[];
  readonly pairs: readonly PairComparison[];
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly cells: Readonly<Record<string, TaskCell>>;
  }>;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function sum(values: ReadonlyArray<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function workglowDetail(trials: readonly TrialRecord[]): WorkglowArmDetail | undefined {
  const runs = trials.flatMap((trial) => (trial.workglow ? [trial.workglow] : []));
  if (runs.length === 0) return undefined;
  const outcomes: Record<string, number> = {};
  const byTool: Record<string, { calls: number; errors: number }> = {};
  for (const run of runs) {
    outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
    for (const [name, tally] of Object.entries(run.tools.byName)) {
      const entry = (byTool[name] ??= { calls: 0, errors: 0 });
      entry.calls += tally.calls;
      entry.errors += tally.errors;
    }
  }
  return {
    outcomes,
    meanRounds: mean(runs.map((run) => run.rounds)),
    retries: sum(runs.map((run) => run.retries)),
    toolCalls: sum(runs.map((run) => run.tools.calls)),
    toolErrors: sum(runs.map((run) => run.tools.errors)),
    byTool,
    maxHistoryChars: Math.max(...runs.map((run) => run.finalHistoryChars)),
  };
}

function summarizeArm(arm: string, trials: readonly TrialRecord[]): ArmSummary {
  const ran = trials.filter((trial) => trial.status !== "blocked");
  const passed = ran.filter((trial) => trial.status === "pass").length;
  const byTask = groupBy(ran, (trial) => trial.task);
  const fractions = [...byTask.values()].map(
    (list) => list.filter((trial) => trial.status === "pass").length / list.length
  );
  const minAttempts = Math.min(...[...byTask.values()].map((list) => list.length));
  const passAtKValue =
    byTask.size > 0 && minAttempts > 1
      ? {
          k: minAttempts,
          value:
            mean(
              [...byTask.values()].map((list) =>
                passAtK(
                  list.length,
                  list.filter((trial) => trial.status === "pass").length,
                  minAttempts
                )
              )
            ) ?? 0,
        }
      : undefined;
  const priced = ran.filter((trial) => trial.costUsd !== undefined);
  const costUsd = priced.length > 0 ? sum(priced.map((trial) => trial.costUsd)) : undefined;
  const failures: Partial<Record<FailureMode, number>> = {};
  for (const trial of ran) {
    if (trial.failure) failures[trial.failure] = (failures[trial.failure] ?? 0) + 1;
  }
  return {
    arm,
    models: [...new Set(trials.flatMap((trial) => (trial.model ? [trial.model] : [])))],
    versions: [
      ...new Set(trials.flatMap((trial) => (trial.agentVersion ? [trial.agentVersion] : []))),
    ],
    tasks: new Set(trials.map((trial) => trial.task)).size,
    trials: trials.length,
    blocked: trials.length - ran.length,
    passed,
    passRate: ran.length > 0 ? passed / ran.length : 0,
    passRateCi: wilsonInterval(passed, ran.length),
    passAt1: mean(fractions) ?? 0,
    passAtK: passAtKValue,
    costUsd,
    costPerPass: costUsd !== undefined && passed > 0 ? costUsd / passed : undefined,
    unpricedTrials: ran.length - priced.length,
    inputTokens: sum(ran.map((trial) => trial.inputTokens)),
    cacheTokens: sum(ran.map((trial) => trial.cacheTokens)),
    outputTokens: sum(ran.map((trial) => trial.outputTokens)),
    medianAgentSec: median(
      ran.flatMap((trial) => (trial.agentSec === undefined ? [] : [trial.agentSec]))
    ),
    failures,
    workglow: workglowDetail(ran),
  };
}

function cell(trials: readonly TrialRecord[]): TaskCell {
  const ran = trials.filter((trial) => trial.status !== "blocked");
  return {
    passes: ran.filter((trial) => trial.status === "pass").length,
    runs: ran.length,
    blocked: trials.length - ran.length,
    failures: ran.flatMap((trial) => (trial.failure ? [trial.failure] : [])),
  };
}

function fraction(c: TaskCell | undefined): number | undefined {
  return c === undefined || c.runs === 0 ? undefined : c.passes / c.runs;
}

/**
 * The paired comparison is the one that answers "is A better than B": both
 * arms ran the same tasks, so a task solved by both or by neither says
 * nothing, and the tasks where they differ are both the evidence and the
 * list worth reading transcripts for.
 */
function comparePair(a: string, b: string, tasks: ComparisonReport["tasks"]): PairComparison {
  let commonTasks = 0;
  let bothPass = 0;
  let neither = 0;
  const aBetter: string[] = [];
  const bBetter: string[] = [];
  for (const { task, cells } of tasks) {
    const fa = fraction(cells[a]);
    const fb = fraction(cells[b]);
    if (fa === undefined || fb === undefined) continue;
    commonTasks++;
    if (fa > fb) aBetter.push(task);
    else if (fb > fa) bBetter.push(task);
    else if (fa === 0) neither++;
    else bothPass++;
  }
  return {
    a,
    b,
    commonTasks,
    bothPass,
    neither,
    aBetter,
    bBetter,
    pValue: mcnemarExactP(aBetter.length, bBetter.length),
  };
}

export function buildReport(trials: readonly TrialRecord[]): ComparisonReport {
  const byArm = groupBy(trials, (trial) => trial.arm);
  const arms = [...byArm.entries()]
    .map(([arm, list]) => summarizeArm(arm, list))
    .sort((x, y) => y.passAt1 - x.passAt1 || x.arm.localeCompare(y.arm));
  const armNames = arms.map((arm) => arm.arm);

  const tasks = [...groupBy(trials, (trial) => trial.task).entries()]
    .map(([task, list]) => {
      const cells: Record<string, TaskCell> = {};
      for (const [arm, armTrials] of groupBy(list, (trial) => trial.arm))
        cells[arm] = cell(armTrials);
      return { task, cells };
    })
    .sort((x, y) => x.task.localeCompare(y.task));

  const pairs: PairComparison[] = [];
  for (let i = 0; i < armNames.length; i++) {
    for (let j = i + 1; j < armNames.length; j++) {
      pairs.push(comparePair(armNames[i]!, armNames[j]!, tasks));
    }
  }
  return { generatedAt: new Date().toISOString(), arms, pairs, tasks };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const usd = (value: number | undefined): string =>
  value === undefined ? "—" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
const int = (value: number): string => value.toLocaleString("en-US");
const secs = (value: number | undefined): string =>
  value === undefined ? "—" : `${value.toFixed(0)}s`;

function markSymbol(c: TaskCell | undefined): string {
  if (c === undefined) return "·";
  if (c.runs === 0) return c.blocked > 0 ? "B" : "·";
  if (c.runs === 1) return c.passes === 1 ? "✓" : `✗ ${c.failures[0] ?? ""}`.trim();
  return `${c.passes}/${c.runs}`;
}

export function renderMarkdown(
  report: ComparisonReport,
  options: { readonly allTasks?: boolean } = {}
): string {
  const lines: string[] = [];
  lines.push(`# Agent harness comparison`, "", `Generated ${report.generatedAt}.`, "");

  lines.push(
    "| Arm | Model | Tasks | Ran | Blocked | Pass rate (95% CI) | pass@1 | pass@k | Cost | $/pass | In tok | Cache tok | Out tok | Median time |",
    "|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  );
  for (const arm of report.arms) {
    const cost =
      arm.unpricedTrials > 0 && arm.costUsd !== undefined
        ? `${usd(arm.costUsd)}*`
        : usd(arm.costUsd);
    lines.push(
      `| ${arm.arm} | ${arm.models.join(", ")} | ${arm.tasks} | ${arm.trials - arm.blocked} | ${arm.blocked} | ` +
        `${pct(arm.passRate)} (${pct(arm.passRateCi.low)}–${pct(arm.passRateCi.high)}) | ${pct(arm.passAt1)} | ` +
        `${arm.passAtK ? `${pct(arm.passAtK.value)} (k=${arm.passAtK.k})` : "—"} | ${cost} | ${usd(arm.costPerPass)} | ` +
        `${int(arm.inputTokens)} | ${int(arm.cacheTokens)} | ${int(arm.outputTokens)} | ${secs(arm.medianAgentSec)} |`
    );
  }
  if (report.arms.some((arm) => arm.unpricedTrials > 0)) {
    lines.push("", "\\* some trials reported no cost; the total covers the rest.");
  }

  lines.push("", "## Head to head", "");
  lines.push(
    "| A | B | Tasks | Both ✓ | Neither | A only | B only | p (exact sign) |",
    "|---|---|---:|---:|---:|---:|---:|---:|"
  );
  for (const pair of report.pairs) {
    lines.push(
      `| ${pair.a} | ${pair.b} | ${pair.commonTasks} | ${pair.bothPass} | ${pair.neither} | ` +
        `${pair.aBetter.length} | ${pair.bBetter.length} | ${pair.pValue.toFixed(3)} |`
    );
  }
  for (const pair of report.pairs) {
    if (pair.aBetter.length + pair.bBetter.length === 0) continue;
    lines.push("", `### ${pair.a} vs ${pair.b}`, "");
    if (pair.aBetter.length > 0)
      lines.push(`- **${pair.a}** better on: ${pair.aBetter.join(", ")}`);
    if (pair.bBetter.length > 0)
      lines.push(`- **${pair.b}** better on: ${pair.bBetter.join(", ")}`);
  }

  lines.push("", "## Why runs failed", "");
  const modes = [
    ...new Set(report.arms.flatMap((arm) => Object.keys(arm.failures))),
  ].sort() as FailureMode[];
  if (modes.length === 0) lines.push("No failures.");
  else {
    lines.push(`| Arm | ${modes.join(" | ")} |`, `|---|${modes.map(() => "---:").join("|")}|`);
    for (const arm of report.arms) {
      lines.push(`| ${arm.arm} | ${modes.map((mode) => arm.failures[mode] ?? 0).join(" | ")} |`);
    }
  }

  const workglowArms = report.arms.filter((arm) => arm.workglow);
  if (workglowArms.length > 0) {
    lines.push("", "## Workglow loop detail", "");
    for (const arm of workglowArms) {
      const detail = arm.workglow!;
      const outcomes = Object.entries(detail.outcomes)
        .map(([outcome, n]) => `${outcome} ${n}`)
        .join(", ");
      const tools = Object.entries(detail.byTool)
        .sort(([, x], [, y]) => y.calls - x.calls)
        .map(([name, t]) => `${name} ${t.calls} (${t.errors} err)`)
        .join(", ");
      lines.push(
        `- **${arm.arm}**: outcomes ${outcomes}; mean rounds ${detail.meanRounds?.toFixed(1) ?? "—"}; ` +
          `retries ${detail.retries}; tool calls ${detail.toolCalls} with ${detail.toolErrors} errors ` +
          `(${tools}); largest transcript ${int(detail.maxHistoryChars)} chars`
      );
    }
  }

  const arms = report.arms.map((arm) => arm.arm);
  const rows = report.tasks.filter((row) => {
    if (options.allTasks) return true;
    const values = arms.map((arm) => fraction(row.cells[arm])).filter((v) => v !== undefined);
    return new Set(values).size > 1 || arms.some((arm) => (row.cells[arm]?.blocked ?? 0) > 0);
  });
  lines.push("", options.allTasks ? "## Every task" : "## Tasks where the arms differ", "");
  if (rows.length === 0) lines.push("None.");
  else {
    lines.push(`| Task | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
    for (const row of rows)
      lines.push(`| ${row.task} | ${arms.map((arm) => markSymbol(row.cells[arm])).join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
