/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JobDataset } from "./suites";

export const HARNESSES = ["workglow", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

/** One column of the comparison: a harness and the kwargs that make it this arm. */
export interface ArmSpec {
  readonly harness: Harness;
  readonly kwargs: Readonly<Record<string, unknown>>;
}

/** Reasoning levels every harness can be set to, in pi's vocabulary. */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ParityOptions {
  /** Model calls each arm may make. Every harness gets the same cap. */
  readonly maxTurns: number;
  readonly effort: Effort;
  /** opencode names reasoning levels per model ("high", "max", …); unset leaves it at its default. */
  readonly opencodeVariant: string | undefined;
  /**
   * pi needs the wire API spelled out when the provider endpoint is
   * overridden (a proxy or a mock): `anthropic-messages`, `openai-responses`, …
   */
  readonly piModelApi: string | undefined;
}

/**
 * The kwargs that hold each harness to the same budget and reasoning level.
 *
 * Without them the arms are not comparable: opencode and pi run until the
 * model stops (no turn cap at all), pi thinks at `medium` by default while the
 * other two do not think unless asked, and AgentTask stops after 8 rounds.
 * An arm's own kwargs win, so an ablation can still move one of these.
 */
export function parityKwargs(harness: Harness, options: ParityOptions): Record<string, unknown> {
  switch (harness) {
    case "workglow":
      return { max_rounds: options.maxTurns, effort: options.effort };
    case "opencode":
      return {
        opencode_config: { agent: { build: { steps: options.maxTurns } } },
        ...(options.opencodeVariant ? { variant: options.opencodeVariant } : {}),
      };
    case "pi":
      return {
        max_turns: options.maxTurns,
        thinking: options.effort,
        ...(options.piModelApi ? { model_api: options.piModelApi } : {}),
      };
  }
}

/**
 * Where the value starting at `start` ends. A JSON string, array or object runs to
 * its closing quote or bracket, so it may hold anything; a bare value runs to the
 * next comma that a `key=` follows, so a sentence or a list can carry its own commas.
 */
function kwargValueEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const open = text[i];
  if (open === '"' || open === "{" || open === "[") {
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') {
          inString = false;
          if (depth === 0) return i + 1;
        }
      } else if (c === '"') {
        inString = true;
      } else if (c === "{" || c === "[") {
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    // An opened value that never closes would otherwise swallow every pair after it.
    throw new Error(`arm kwarg value starting ${text.slice(start).trim()} is never closed`);
  }
  const next = text.slice(start).search(/,(?=\s*[A-Za-z_][\w-]*=)/);
  return next === -1 ? text.length : start + next;
}

/**
 * `workglow`, `pi:thinking=high`, `workglow:tool_concurrency=8,max_history_chars=400000`.
 * Values are JSON where they parse as JSON, strings otherwise — Harbor's own
 * `--ak` rule. A value holding a comma followed by `key=` is written as a JSON
 * string: `workglow:append_system_prompt="When x=a, set y=b"`.
 */
export function parseArm(spec: string): ArmSpec {
  const colon = spec.indexOf(":");
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  if (!(HARNESSES as readonly string[]).includes(name)) {
    throw new Error(`unknown harness "${name}" — one of ${HARNESSES.join(", ")}`);
  }
  const kwargs: Record<string, unknown> = {};
  const body = colon === -1 ? "" : spec.slice(colon + 1);
  let pos = 0;
  while (pos < body.length) {
    const eq = body.indexOf("=", pos);
    const comma = body.indexOf(",", pos);
    if (eq === -1 || (comma !== -1 && comma < eq)) {
      const pair = body.slice(pos, comma === -1 ? undefined : comma).trim();
      if (pair !== "") throw new Error(`arm kwarg "${pair}" must be key=value`);
      pos = comma === -1 ? body.length : comma + 1;
      continue;
    }
    const key = body.slice(pos, eq).trim();
    const end = kwargValueEnd(body, eq + 1);
    const raw = body.slice(eq + 1, end).trim();
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // A bare string.
    }
    kwargs[key] = value;
    const after = body.indexOf(",", end);
    const trailing = body.slice(end, after === -1 ? undefined : after).trim();
    if (trailing !== "")
      throw new Error(`arm kwarg "${key}" has text after its value: ${trailing}`);
    pos = after === -1 ? body.length : after + 1;
  }
  return { harness: name as Harness, kwargs };
}

export interface HarborJobOptions {
  readonly jobName: string;
  readonly jobsDir: string;
  readonly model: string;
  readonly arms: readonly ArmSpec[];
  readonly datasets: readonly JobDataset[];
  readonly parity: ParityOptions;
  readonly attempts: number;
  readonly concurrency: number;
  readonly timeoutMultiplier: number | undefined;
}

/**
 * Exceptions that mean the infrastructure failed before or around the agent:
 * a container that would not build or start (Docker reports those as
 * `RuntimeError`), or an install that timed out. Retrying them is free of
 * bias. Nothing the agent itself did is listed — retrying an agent failure
 * would turn one attempt into best-of-n for whichever arm failed more.
 */
export const INFRASTRUCTURE_RETRY_EXCEPTIONS = [
  "RuntimeError",
  "EnvironmentStartTimeoutError",
  "AgentSetupTimeoutError",
] as const;

/**
 * One Harbor job holding every arm, so all of them run the same task list
 * under the same environment settings; the comparison then pairs trials by
 * task. The workglow arm is loaded by import path, which needs this
 * package's `harbor/` directory on PYTHONPATH.
 */
export function buildHarborJob(options: HarborJobOptions): Record<string, unknown> {
  return {
    job_name: options.jobName,
    jobs_dir: options.jobsDir,
    n_attempts: options.attempts,
    n_concurrent_trials: options.concurrency,
    retry: { max_retries: 2, include_exceptions: [...INFRASTRUCTURE_RETRY_EXCEPTIONS] },
    ...(options.timeoutMultiplier === undefined
      ? {}
      : { timeout_multiplier: options.timeoutMultiplier }),
    agents: options.arms.map((arm) => {
      const kwargs = { ...parityKwargs(arm.harness, options.parity), ...arm.kwargs };
      return arm.harness === "workglow"
        ? { import_path: "workglow_agent:WorkglowAgent", model_name: options.model, kwargs }
        : { name: arm.harness, model_name: options.model, kwargs };
    }),
    datasets: options.datasets.map((dataset) => ({ ...dataset })),
  };
}
