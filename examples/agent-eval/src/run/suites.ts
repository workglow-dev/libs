/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** One Harbor registry dataset, optionally narrowed to some of its tasks. */
export interface SuiteDataset {
  readonly name: string;
  readonly version: string;
  /** Glob patterns over task names. */
  readonly task_names?: readonly string[] | undefined;
  /** Cap applied after `task_names`, in registry order. */
  readonly n_tasks?: number | undefined;
}

/**
 * A directory of Harbor task folders on disk — a custom benchmark, or a local
 * copy of a registry dataset prepared for an environment the registry copy
 * cannot build in.
 */
export interface LocalDataset {
  readonly path: string;
  readonly task_names?: readonly string[] | undefined;
  readonly n_tasks?: number | undefined;
}

export type JobDataset = SuiteDataset | LocalDataset;

export interface Suite {
  readonly description: string;
  readonly datasets: readonly SuiteDataset[];
}

/**
 * Named slices of public benchmarks in Harbor's registry. Each is chosen for
 * what it exercises in a loop, not only for its name:
 *
 * - Terminal-Bench 2.0 is long-horizon terminal work — builds, services,
 *   debugging — where context growth, command timeouts and recovery from tool
 *   errors decide the outcome.
 * - Aider Polyglot is short edit-run-fix cycles in six languages, where edit
 *   reliability and reading test output dominate.
 * - SWE-bench Verified is repository navigation and a minimal patch in a
 *   large Python codebase: search, reading at scale, and not breaking
 *   neighbouring tests.
 */
export const SUITES: Readonly<Record<string, Suite>> = {
  smoke: {
    description:
      "hello-world plus the 10-task Terminal-Bench sample: does every arm install and run",
    datasets: [
      { name: "hello-world", version: "1.0" },
      { name: "terminal-bench-sample", version: "2.0" },
    ],
  },
  "terminal-bench": {
    description: "Terminal-Bench 2.0, all 89 tasks",
    datasets: [{ name: "terminal-bench", version: "2.0" }],
  },
  polyglot: {
    description: "Aider Polyglot, all 225 exercises in six languages",
    datasets: [{ name: "aider-polyglot", version: "1.0" }],
  },
  "polyglot-lite": {
    description: "Aider Polyglot, Python and JavaScript only (83 exercises)",
    datasets: [
      {
        name: "aider-polyglot",
        version: "1.0",
        task_names: ["polyglot_python_*", "polyglot_javascript_*"],
      },
    ],
  },
  "swebench-50": {
    description: "SWE-bench Verified, the first 50 tasks in registry order",
    datasets: [{ name: "swebench-verified", version: "1.0", n_tasks: 50 }],
  },
  core: {
    description:
      "Terminal-Bench 2.0 + Polyglot (Python/JS) + SWE-bench Verified 50: the decision set",
    datasets: [
      { name: "terminal-bench", version: "2.0" },
      {
        name: "aider-polyglot",
        version: "1.0",
        task_names: ["polyglot_python_*", "polyglot_javascript_*"],
      },
      { name: "swebench-verified", version: "1.0", n_tasks: 50 },
    ],
  },
};

export function getSuite(name: string): Suite {
  const suite = SUITES[name];
  if (suite === undefined) {
    throw new Error(`unknown suite "${name}" — one of ${Object.keys(SUITES).join(", ")}`);
  }
  return suite;
}
