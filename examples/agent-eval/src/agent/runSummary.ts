/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentStep } from "@workglow/ai";

/** How a run ended: the loop's own stop reason, or the error that ended it. */
export type AgentRunOutcome =
  | "answered"
  | "submitted"
  | "budget"
  | "max-rounds"
  | "error"
  | "aborted";

export interface AgentRunUsage {
  /** Prompt tokens not served from cache. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Every prompt token, cached or not — what Harbor reports as input. */
  readonly promptTokens: number;
  /** Rounds whose provider reported no usage at all. */
  readonly unreportedRounds: number;
}

export interface AgentToolTally {
  readonly calls: number;
  readonly errors: number;
  readonly byName: Readonly<Record<string, { calls: number; errors: number }>>;
}

/**
 * Everything the comparison reads about one workglow run, written to
 * `summary.json` beside the transcript. The Harbor adapter copies the token
 * and cost totals into its trial result; the rest rides along as metadata.
 */
export interface AgentRunSummary {
  readonly harness: "workglow";
  readonly model: string;
  readonly outcome: AgentRunOutcome;
  readonly error: string | undefined;
  readonly rounds: number;
  /** Model calls that failed and were retried. */
  readonly retries: number;
  readonly durationMs: number;
  readonly modelMs: number;
  readonly usage: AgentRunUsage;
  /** Undefined when any round could not be priced. */
  readonly costUsd: number | undefined;
  readonly tools: AgentToolTally;
  /**
   * Size of the transcript, in characters, as AgentTask's history budget
   * measures it: a reasoning block's replay `payload` is left out, so the
   * figure compares with `maxHistoryChars` rather than with encrypted reasoning.
   */
  readonly finalHistoryChars: number;
  readonly finalText: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

export function summarizeUsage(steps: readonly AgentStep[]): AgentRunUsage {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let unreportedRounds = 0;
  for (const step of steps) {
    const usage = step.usage;
    if (usage === undefined) {
      unreportedRounds++;
      continue;
    }
    inputTokens += (usage.input ?? 0) + (usage.imageInput ?? 0);
    cacheReadTokens += (usage.cached ?? 0) + (usage.imageCached ?? 0);
    cacheWriteTokens += usage.cacheWrite ?? 0;
    outputTokens += usage.output ?? 0;
  }
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    unreportedRounds,
  };
}

export function tallyTools(steps: readonly AgentStep[]): AgentToolTally {
  const byName: Record<string, { calls: number; errors: number }> = {};
  let calls = 0;
  let errors = 0;
  for (const step of steps) {
    for (const tool of step.tools) {
      const entry = (byName[tool.name] ??= { calls: 0, errors: 0 });
      entry.calls++;
      calls++;
      if (tool.isError) {
        entry.errors++;
        errors++;
      }
    }
  }
  return { calls, errors, byName };
}

/** Sum of round costs, or undefined as soon as one round has none. */
export function totalCost(steps: readonly AgentStep[]): number | undefined {
  let total = 0;
  for (const step of steps) {
    if (step.costUsd === undefined) return undefined;
    total += step.costUsd;
  }
  return steps.length > 0 ? total : undefined;
}
