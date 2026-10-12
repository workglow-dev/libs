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

function globRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** A glob with exactly one `*` and no `?`, split at the star. */
function splitStar(glob: string): { readonly head: string; readonly tail: string } | undefined {
  const star = glob.indexOf("*");
  if (star < 0 || glob.indexOf("*", star + 1) >= 0 || glob.includes("?")) return undefined;
  return { head: glob.slice(0, star), tail: glob.slice(star + 1) };
}

/**
 * Globs matching exactly the names that start with `prefix` and end with `suffix`.
 * `prefix*suffix` alone misses the names where the two overlap (`ab` and `bc` both
 * match `abc`), so each such overlap is listed as a literal name beside it.
 */
function prefixSuffixGlobs(prefix: string, suffix: string): string[] {
  if (suffix === "") return [`${prefix}*`];
  const globs = [`${prefix}*${suffix}`];
  for (let k = Math.min(prefix.length, suffix.length); k > 0; k--) {
    if (prefix.endsWith(suffix.slice(0, k))) globs.push(prefix + suffix.slice(k));
  }
  return globs;
}

/**
 * `glob` itself when every name it can match already falls under `prefixGlob`
 * (`P*`), `[]` when none can, `undefined` when that cannot be told apart here.
 * Decided when `glob` has no `*` (each character matches exactly one, so a
 * fixed-length match either covers the prefix or contradicts it), and when it
 * holds a single `*` whose head already covers the prefix. This is what lets a
 * `?`-filter narrower than a suite's `prefix_*` pattern through.
 */
function subsetOfPrefix(glob: string, prefixGlob: string): string[] | undefined {
  const split = splitStar(prefixGlob);
  if (!split || split.tail !== "") return undefined;
  const prefix = split.head;
  if (!glob.includes("*")) {
    if (glob.length < prefix.length) return [];
    for (let i = 0; i < prefix.length; i++) {
      if (glob[i] !== prefix[i] && glob[i] !== "?") return [];
    }
    return [glob];
  }
  // A single-`*` glob (which may also hold `?`) whose head already covers the
  // prefix matches only inside it (`polyglot_python_?*` needs one more
  // character after the suite's `polyglot_python_*` prefix). A `?` inside the
  // prefix range is only a partial overlap, and a head short of the prefix
  // reaches into the star, so neither can be written down here.
  const star = glob.indexOf("*");
  if (star < 0 || glob.indexOf("*", star + 1) >= 0) return undefined;
  const head = glob.slice(0, star);
  // A contradiction inside the overlap means no name matches both, even when
  // the head is short of the prefix. Past the overlap a short head reaches
  // into the star, so only a head covering the whole prefix proves the subset.
  const compared = Math.min(head.length, prefix.length);
  for (let i = 0; i < compared; i++) {
    if (head[i] === prefix[i] || prefix[i] === "?") continue;
    return head[i] === "?" ? undefined : [];
  }
  if (head.length < prefix.length) return undefined;
  return [glob];
}

/**
 * The task names `a` and `b` both match, as globs Harbor takes as one list: `[]` when
 * no name can match both, `undefined` when the overlap is not one this can write down.
 * Decided for literals, and for a single-`*` glob against a prefix glob (`P*`), which
 * is the shape every suite here restricts itself with; never for a `[...]` class.
 */
function globIntersection(a: string, b: string): string[] | undefined {
  if (a === b) return [a];
  // Harbor matches with fnmatch, where `[...]` is a character class; nothing here
  // reasons about classes, so an overlap involving one is not written down.
  if (a.includes("[") || b.includes("[")) return undefined;
  if (!/[*?]/.test(a)) return globRegExp(b).test(a) ? [a] : [];
  if (!/[*?]/.test(b)) return globRegExp(a).test(b) ? [b] : [];
  const sa = splitStar(a);
  const sb = splitStar(b);
  if (!sa || !sb) {
    // One side may be a `?`-glob with no `*` decided against the other's
    // prefix above; anything wider stays unwritable.
    return subsetOfPrefix(a, b) ?? subsetOfPrefix(b, a);
  }
  const [glob, prefix] = sb.tail === "" ? [sa, sb.head] : sa.tail === "" ? [sb, sa.head] : [];
  if (!glob || prefix === undefined) return undefined;
  if (glob.head.startsWith(prefix)) return [`${glob.head}*${glob.tail}`];
  if (prefix.startsWith(glob.head)) return prefixSuffixGlobs(prefix, glob.tail);
  return [];
}

/**
 * A dataset narrowed by `--tasks` and `--n-tasks`. Both only ever narrow: the
 * filter is intersected with the tasks the suite already restricts itself to
 * (Harbor takes one list, so the intersection is computed here), and the cap
 * replaces the suite's only when it is lower. Undefined when the filter shares
 * no task with the dataset, which then has nothing to run.
 */
export function narrowDataset<T extends JobDataset>(
  dataset: T,
  taskFilter: readonly string[] | undefined,
  nTasks: number | undefined
): T | undefined {
  let taskNames = dataset.task_names;
  if (taskFilter && taskFilter.length > 0) {
    if (!taskNames) {
      taskNames = [...taskFilter];
    } else {
      const kept = new Set<string>();
      for (const wanted of taskFilter) {
        for (const allowed of taskNames) {
          const both = globIntersection(wanted, allowed);
          if (both === undefined) {
            throw new Error(
              `--tasks ${wanted} cannot be narrowed to this suite's ${allowed}: use a task ` +
                `name, or a glob with at most one "*" and no [...] that stays within one of the suite's ` +
                `(${taskNames.join(", ")})`
            );
          }
          for (const glob of both) kept.add(glob);
        }
      }
      if (kept.size === 0) return undefined;
      taskNames = [...kept];
    }
  }
  const cap =
    nTasks === undefined
      ? dataset.n_tasks
      : dataset.n_tasks === undefined
        ? nTasks
        : Math.min(dataset.n_tasks, nTasks);
  return {
    ...dataset,
    ...(taskNames ? { task_names: taskNames } : {}),
    ...(cap === undefined ? {} : { n_tasks: cap }),
  };
}
