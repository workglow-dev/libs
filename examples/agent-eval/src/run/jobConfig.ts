/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SuiteDataset } from "./suites";

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
 * `workglow`, `pi:thinking=high`, `workglow:tool_concurrency=8,max_history_chars=400000`.
 * Values are JSON where they parse as JSON, strings otherwise — Harbor's own
 * `--ak` rule.
 */
export function parseArm(spec: string): ArmSpec {
  const colon = spec.indexOf(":");
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  if (!(HARNESSES as readonly string[]).includes(name)) {
    throw new Error(`unknown harness "${name}" — one of ${HARNESSES.join(", ")}`);
  }
  const kwargs: Record<string, unknown> = {};
  if (colon !== -1) {
    for (const pair of spec.slice(colon + 1).split(",")) {
      if (pair.trim() === "") continue;
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`arm kwarg "${pair}" must be key=value`);
      const raw = pair.slice(eq + 1).trim();
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        // A bare string.
      }
      kwargs[pair.slice(0, eq).trim()] = value;
    }
  }
  return { harness: name as Harness, kwargs };
}

export interface HarborJobOptions {
  readonly jobName: string;
  readonly jobsDir: string;
  readonly model: string;
  readonly arms: readonly ArmSpec[];
  readonly datasets: readonly SuiteDataset[];
  readonly parity: ParityOptions;
  readonly attempts: number;
  readonly concurrency: number;
  readonly timeoutMultiplier: number | undefined;
}

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
