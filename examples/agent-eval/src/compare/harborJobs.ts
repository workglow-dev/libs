/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * How a trial ended, from the comparison's point of view.
 *
 * `blocked` is the one that never reaches a pass rate: the environment or the
 * agent's install failed before the agent saw the task, so the trial measured
 * the infrastructure. Counting it as a failure would charge a harness for a
 * flaky registry; dropping it silently would shrink one arm's denominator.
 * It is excluded and reported.
 */
export type TrialStatus = "pass" | "fail" | "blocked";

/** Why a trial that ran did not pass, coarse enough to tally across harnesses. */
export type FailureMode =
  | "wrong-answer"
  | "agent-timeout"
  | "context-overflow"
  | "max-rounds"
  | "budget"
  | "rate-limit"
  | "provider-error"
  | "agent-crash"
  | "verifier-error";

export interface TrialRecord {
  readonly job: string;
  readonly trial: string;
  readonly task: string;
  /**
   * The comparison column: the agent, plus whatever tells this configuration
   * from the agent's others in the same comparison — e.g.
   * `workglow[tool_concurrency=8]`, or `pi@openai/gpt-5.5` when models differ.
   */
  readonly arm: string;
  /** The agent kwargs this trial ran with. */
  readonly kwargs: Readonly<Record<string, unknown>>;
  readonly agent: string;
  readonly agentVersion: string | undefined;
  readonly model: string | undefined;
  readonly reward: number | undefined;
  readonly status: TrialStatus;
  readonly failure: FailureMode | undefined;
  readonly exceptionType: string | undefined;
  readonly exceptionMessage: string | undefined;
  readonly inputTokens: number | undefined;
  readonly cacheTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly costUsd: number | undefined;
  readonly agentSec: number | undefined;
  readonly setupSec: number | undefined;
  /** The workglow summary the adapter stores on the trial, when this arm is workglow. */
  readonly workglow: WorkglowTrialMetadata | undefined;
}

export interface WorkglowTrialMetadata {
  readonly outcome: string;
  readonly error?: string | undefined;
  readonly rounds: number;
  readonly retries: number;
  readonly tools: {
    readonly calls: number;
    readonly errors: number;
    readonly byName: Readonly<Record<string, { calls: number; errors: number }>>;
  };
  readonly finalHistoryChars: number;
}

interface HarborTrialJson {
  readonly trial_name?: string;
  readonly task_name?: string;
  readonly config?: {
    readonly agent?: { name?: string; import_path?: string; kwargs?: Record<string, unknown> };
  };
  readonly agent_info?: {
    readonly name?: string;
    readonly version?: string;
    readonly model_info?: { readonly name?: string; readonly provider?: string } | null;
  };
  readonly agent_result?: {
    readonly n_input_tokens?: number | null;
    readonly n_cache_tokens?: number | null;
    readonly n_output_tokens?: number | null;
    readonly cost_usd?: number | null;
    readonly metadata?: { readonly workglow?: WorkglowTrialMetadata } | null;
  } | null;
  readonly verifier_result?: { readonly rewards?: Record<string, number> | null } | null;
  readonly exception_info?: {
    readonly exception_type?: string;
    readonly exception_message?: string;
  } | null;
  readonly agent_setup?: Span | null;
  readonly agent_execution?: Span | null;
  readonly environment_setup?: Span | null;
}

interface Span {
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
}

function seconds(span: Span | null | undefined): number | undefined {
  if (!span?.started_at || !span.finished_at) return undefined;
  const ms = Date.parse(span.finished_at) - Date.parse(span.started_at);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** Kwargs that only say where things are, not how the agent behaves. */
const NEUTRAL_KWARGS = new Set(["bundle_path", "version"]);

function kwargValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Names each trial's arm. A kwarg appears in a label only when the agent ran
 * with more than one value for it in this comparison: the parity settings every
 * arm carries would otherwise make every label unreadable, and an ablation's
 * one changed setting is exactly what should show.
 */
export function labelArms(trials: readonly TrialRecord[]): TrialRecord[] {
  const models = new Set(trials.map((trial) => trial.model));
  const varying = new Map<string, Set<string>>();
  const byAgent = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const list = byAgent.get(trial.agent) ?? [];
    list.push(trial);
    byAgent.set(trial.agent, list);
  }
  for (const [agent, list] of byAgent) {
    const keys = new Set(list.flatMap((trial) => Object.keys(trial.kwargs)));
    const differ = new Set<string>();
    for (const key of keys) {
      if (NEUTRAL_KWARGS.has(key)) continue;
      const values = new Set(list.map((trial) => kwargValue(trial.kwargs[key])));
      if (values.size > 1) differ.add(key);
    }
    varying.set(agent, differ);
  }
  return trials.map((trial) => {
    const keys = [...(varying.get(trial.agent) ?? [])].sort();
    const parts = keys
      .filter((key) => trial.kwargs[key] !== undefined)
      .map((key) => `${key}=${kwargValue(trial.kwargs[key])}`);
    const model = models.size > 1 && trial.model ? `@${trial.model}` : "";
    return {
      ...trial,
      arm: `${trial.agent}${model}${parts.length > 0 ? `[${parts.join(",")}]` : ""}`,
    };
  });
}

const OVERFLOW =
  /context(?:[ _](?:length|window))|maximum context|prompt is too long|too many tokens|exceeds the (?:context|maximum)|input token count exceeds/i;
const RATE = /rate.?limit|429|too many requests|overloaded|quota/i;

/**
 * Classifies a trial. A reward is believed whenever the verifier produced
 * one, even after an agent exception: an agent that timed out after writing
 * the right answer did solve the task, which is how Harbor scores it too.
 */
export function classifyTrial(
  reward: number | undefined,
  exceptionType: string | undefined,
  exceptionMessage: string | undefined,
  agentRan: boolean,
  workglow: WorkglowTrialMetadata | undefined
): { status: TrialStatus; failure: FailureMode | undefined } {
  if (reward !== undefined && reward >= 1 - 1e-9) return { status: "pass", failure: undefined };
  if (!agentRan && exceptionType !== undefined) return { status: "blocked", failure: undefined };

  const text = `${exceptionType ?? ""} ${exceptionMessage ?? ""} ${workglow?.error ?? ""}`;
  let failure: FailureMode;
  if (exceptionType === "AgentTimeoutError") failure = "agent-timeout";
  else if (exceptionType === "ContextWindowExceededError" || OVERFLOW.test(workglow?.error ?? ""))
    failure = "context-overflow";
  else if (workglow?.outcome === "max-rounds") failure = "max-rounds";
  else if (workglow?.outcome === "budget") failure = "budget";
  else if (exceptionType !== undefined && /RateLimit|UsageLimit|Overloaded/.test(exceptionType))
    failure = "rate-limit";
  else if (
    exceptionType !== undefined &&
    /Api|Network|Authentication|ModelNotFound/.test(exceptionType)
  )
    failure = RATE.test(text) ? "rate-limit" : "provider-error";
  else if (exceptionType !== undefined && /Verifier|RewardFile|AddTests/.test(exceptionType))
    failure = "verifier-error";
  else if (exceptionType !== undefined)
    failure = OVERFLOW.test(text) ? "context-overflow" : "agent-crash";
  else if (workglow?.outcome === "error")
    failure = OVERFLOW.test(text) ? "context-overflow" : "agent-crash";
  else failure = "wrong-answer";
  return { status: "fail", failure };
}

export function parseTrial(json: HarborTrialJson, job: string): TrialRecord | undefined {
  if (!json.trial_name || !json.task_name) return undefined;
  const configured = json.config?.agent;
  const agent = json.agent_info?.name ?? configured?.name ?? configured?.import_path ?? "unknown";
  const rewards = json.verifier_result?.rewards ?? undefined;
  const reward = rewards ? (rewards.reward ?? Object.values(rewards)[0]) : undefined;
  const exceptionType = json.exception_info?.exception_type ?? undefined;
  const exceptionMessage = json.exception_info?.exception_message ?? undefined;
  const agentRan = !!json.agent_execution?.started_at;
  const workglow = json.agent_result?.metadata?.workglow ?? undefined;
  const { status, failure } = classifyTrial(
    reward,
    exceptionType,
    exceptionMessage,
    agentRan,
    workglow
  );
  const model = json.agent_info?.model_info
    ? `${json.agent_info.model_info.provider ?? "?"}/${json.agent_info.model_info.name ?? "?"}`
    : undefined;
  const result = json.agent_result ?? undefined;
  return {
    job,
    trial: json.trial_name,
    task: json.task_name,
    arm: agent,
    kwargs: configured?.kwargs ?? {},
    agent,
    agentVersion: json.agent_info?.version,
    model,
    reward,
    status,
    failure,
    exceptionType,
    exceptionMessage,
    inputTokens: result?.n_input_tokens ?? undefined,
    cacheTokens: result?.n_cache_tokens ?? undefined,
    outputTokens: result?.n_output_tokens ?? undefined,
    costUsd: result?.cost_usd ?? undefined,
    agentSec: seconds(json.agent_execution),
    setupSec: seconds(json.agent_setup),
    workglow,
  };
}

/** Every trial `result.json` at or below `path` (a trial dir, a job dir, or a jobs dir). */
function findTrialResults(path: string, depth = 0): string[] {
  if (!existsSync(path)) throw new Error(`no such path: ${path}`);
  if (statSync(path).isFile()) return [path];
  const own = join(path, "result.json");
  const found: string[] = [];
  if (existsSync(own) && existsSync(join(path, "agent"))) return [own];
  if (depth >= 3) return found;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...findTrialResults(join(path, entry.name), depth + 1));
  }
  return found;
}

export function loadTrials(paths: readonly string[]): TrialRecord[] {
  const trials: TrialRecord[] = [];
  for (const path of paths) {
    for (const file of findTrialResults(path)) {
      let json: HarborTrialJson;
      try {
        json = JSON.parse(readFileSync(file, "utf8")) as HarborTrialJson;
      } catch {
        continue;
      }
      const record = parseTrial(json, basename(dirname(dirname(file))));
      if (record) trials.push(record);
    }
  }
  return labelArms(trials);
}
