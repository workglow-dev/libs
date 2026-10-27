/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One `Build & Test` workflow run, as `gh run list --json` reports it.
 *
 * `status` is the lifecycle (`queued` / `in_progress` / `completed`) and
 * `conclusion` is only meaningful once it reads `completed` — an in-flight run
 * carries an empty conclusion, which is not the same as a failure and must not
 * be read as one.
 */
export interface WorkflowRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

export type CiVerdict =
  | { readonly ok: true; readonly run: WorkflowRun }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a commit's CI is green enough to publish from.
 *
 * Only the newest run counts. A commit can carry several — a re-run after a
 * flake, a `workflow_dispatch` beside the push — and requiring all of them to
 * be green would make a superseded red run unpublishable forever, while
 * accepting any green one would let a re-run that went red be papered over by
 * the failure it replaced. `gh run list` returns newest first.
 *
 * An empty list is refused rather than allowed. "No run for this commit" is the
 * state a brand-new commit is in, which is exactly the state the gate exists to
 * catch — the release would publish code no workflow has ever built.
 */
export function evaluateCiRuns(runs: readonly WorkflowRun[], sha: string): CiVerdict {
  const newest = runs[0];
  if (newest === undefined) {
    return {
      ok: false,
      reason:
        `No \`Build & Test\` run found for ${sha}. Push the commit and let CI ` +
        `finish before publishing from it.`,
    };
  }
  if (newest.status !== "completed") {
    return {
      ok: false,
      reason: `\`Build & Test\` for ${sha} is still ${newest.status}: ${newest.url}`,
    };
  }
  if (newest.conclusion !== "success") {
    return {
      ok: false,
      reason: `\`Build & Test\` for ${sha} concluded "${newest.conclusion}": ${newest.url}`,
    };
  }
  return { ok: true, run: newest };
}

/** `run` is undefined when the guard has never finished a run worth reading. */
export type NightlyVerdict =
  | { readonly ok: true; readonly run: WorkflowRun | undefined }
  | { readonly ok: false; readonly reason: string };

/** Conclusions that say whether a nightly guard passed; anything else says nothing. */
const DECISIVE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "timed_out",
  "startup_failure",
]);

/**
 * Whether the most recent nightly guard run on `main` leaves a release free to
 * go out.
 *
 * The guard checks `main` rather than the release commit, so it cannot be the
 * commit's own run; what it can say is that `main` is known to be broken in a
 * way `Build & Test` does not look at. Runs are newest first, as `gh run list`
 * returns them. One still in flight or cancelled is skipped for the newest that
 * finished, and a guard that has never finished a run refuses nothing — there
 * is no red to refuse on. `limit` is how many runs were asked for: a full page
 * with no finished run in it is a truncated history, not an empty one, and the
 * red run that decides it may sit just past the page.
 */
export function evaluateNightlyGuard(
  runs: readonly WorkflowRun[],
  workflow: string,
  limit: number
): NightlyVerdict {
  const latest = runs.find(
    (run) => run.status === "completed" && DECISIVE_CONCLUSIONS.has(run.conclusion)
  );
  if (latest === undefined && runs.length >= limit) {
    return {
      ok: false,
      reason:
        `None of the latest ${limit} \`${workflow}\` runs on main finished, so whether ` +
        `main is red cannot be read.\n` +
        `  Let a run finish (\`gh workflow run ${workflow} --ref main\`) and publish once it is green.`,
    };
  }
  if (latest === undefined || latest.conclusion === "success") return { ok: true, run: latest };
  return {
    ok: false,
    reason:
      `The latest \`${workflow}\` run on main concluded "${latest.conclusion}": ${latest.url}\n` +
      `  Fix main, then re-run the guard (\`gh workflow run ${workflow} --ref main\`) ` +
      `and publish once it is green.`,
  };
}
