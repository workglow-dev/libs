/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The decision half of `.github/workflows/ci-alert.yml`: given one completed
 * run of a watched workflow and the open tracking issues, what to do. The I/O
 * half is `scripts/ci-alert.ts`.
 *
 * A red scheduled run is only a row in the Actions tab, and a guard that can
 * stay red for a month unseen enforces nothing. So each watched workflow gets
 * ONE open issue while it is red on `main`: the first failure opens it, each
 * further failure comments on it, and the next green run closes it.
 */

/** Every tracking issue carries this label, which is also how they are found. */
export const CI_ALERT_LABEL = "ci-nightly";

/** The only branch whose runs are alerted on. */
export const CI_ALERT_BRANCH = "main";

/**
 * Events whose runs say something about `main` itself. A `pull_request` run
 * says something about the PR, whatever branch it reports, so it is never
 * alerted on.
 */
const ALERTING_EVENTS: ReadonlySet<string> = new Set(["push", "schedule", "workflow_dispatch"]);

/** Conclusions that mean the workflow ran and found something wrong. */
const RED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * The fields of a `workflow_run` webhook payload this reads, flattened.
 *
 * `headRepository` matters because `head_branch` is just a name: a pull request
 * from a fork's own `main` reports `main` too.
 */
export interface CompletedRun {
  readonly workflowName: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepository: string;
  readonly repository: string;
  readonly conclusion: string;
  readonly url: string;
  readonly runNumber: number;
  readonly runAttempt: number;
}

export type RunClass =
  | { readonly kind: "red" }
  | { readonly kind: "green" }
  | { readonly kind: "ignore"; readonly reason: string };

/**
 * Whether a run counts for or against `main`.
 *
 * `cancelled` is neither: `Build & Test` cancels an in-flight `main` run when
 * the next push lands, so a cancellation says nothing about the code, and
 * closing an issue on one would report a fix nobody made.
 */
export function classifyRun(run: CompletedRun): RunClass {
  if (!ALERTING_EVENTS.has(run.event)) {
    return { kind: "ignore", reason: `event "${run.event}" does not describe ${CI_ALERT_BRANCH}` };
  }
  if (run.headBranch !== CI_ALERT_BRANCH) {
    return { kind: "ignore", reason: `branch "${run.headBranch}" is not ${CI_ALERT_BRANCH}` };
  }
  if (run.headRepository !== run.repository) {
    return {
      kind: "ignore",
      reason: `run is from ${run.headRepository}, not ${run.repository}`,
    };
  }
  if (run.conclusion === "success") return { kind: "green" };
  if (RED_CONCLUSIONS.has(run.conclusion)) return { kind: "red" };
  return { kind: "ignore", reason: `conclusion "${run.conclusion}" is neither green nor red` };
}

/** The exact title a workflow's tracking issue carries; lookup matches it exactly. */
export function issueTitle(workflowName: string): string {
  return `CI red on ${CI_ALERT_BRANCH}: ${workflowName}`;
}

/** An open issue carrying {@link CI_ALERT_LABEL}. */
export interface OpenIssue {
  readonly number: number;
  readonly title: string;
}

export type AlertAction =
  | { readonly kind: "open"; readonly title: string; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issues: readonly number[]; readonly body: string }
  | { readonly kind: "none"; readonly reason: string };

function runFacts(run: CompletedRun, failedJobs: readonly string[]): string {
  const attempt = run.runAttempt > 1 ? `, attempt ${run.runAttempt}` : "";
  const lines = [
    `- Run: ${run.url} (#${run.runNumber}${attempt})`,
    `- Event: \`${run.event}\``,
    `- Commit: ${run.headSha}`,
    `- Conclusion: \`${run.conclusion}\``,
  ];
  if (failedJobs.length > 0) {
    lines.push(`- Failed jobs: ${failedJobs.map((job) => `\`${job}\``).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * What to do about one completed run.
 *
 * Only issues whose title is exactly {@link issueTitle} count, so one
 * workflow's issue is never touched by another's runs. Were there ever two
 * open for one workflow, a failure comments on the oldest and a success closes
 * every one of them, which brings the set back to one or none.
 */
export function planAlert(
  run: CompletedRun,
  openIssues: readonly OpenIssue[],
  failedJobs: readonly string[] = []
): AlertAction {
  const verdict = classifyRun(run);
  if (verdict.kind === "ignore") return { kind: "none", reason: verdict.reason };

  const title = issueTitle(run.workflowName);
  const tracking = openIssues
    .filter((issue) => issue.title === title)
    .map((issue) => issue.number)
    .sort((a, b) => a - b);

  if (verdict.kind === "green") {
    if (tracking.length === 0) return { kind: "none", reason: "green, and no issue is open" };
    return {
      kind: "close",
      issues: tracking,
      body:
        `\`${run.workflowName}\` is green on \`${CI_ALERT_BRANCH}\` again, so this is closed.\n\n` +
        runFacts(run, []),
    };
  }

  const facts = runFacts(run, failedJobs);
  if (tracking.length > 0) {
    return {
      kind: "comment",
      issue: tracking[0]!,
      body: `\`${run.workflowName}\` failed again on \`${CI_ALERT_BRANCH}\`.\n\n${facts}`,
    };
  }
  return {
    kind: "open",
    title,
    body:
      `\`${run.workflowName}\` failed on \`${CI_ALERT_BRANCH}\`.\n\n${facts}\n\n` +
      `Opened by \`.github/workflows/ci-alert.yml\`. Each further failure on ` +
      `\`${CI_ALERT_BRANCH}\` comments here, and the next successful run closes this issue.`,
  };
}
