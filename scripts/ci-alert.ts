#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opens, comments on or closes the tracking issue for one completed run of a
 * watched workflow. Run by `.github/workflows/ci-alert.yml` on `workflow_run`;
 * the decision is `planAlert` in `./lib/ciAlert`, and this file only reads the
 * event and talks to the REST API.
 *
 * Imports nothing outside `node:` and `./lib`, so the alert job needs no
 * `bun install` — it is the job that has to work when the install is what broke.
 */
import { readFileSync } from "node:fs";
import type { AlertAction, CompletedRun, OpenIssue } from "./lib/ciAlert";
import { CI_ALERT_LABEL, classifyRun, planAlert } from "./lib/ciAlert";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REPO = requireEnv("GITHUB_REPOSITORY");
const TOKEN = requireEnv("GITHUB_TOKEN");

async function github(
  method: string,
  path: string,
  body?: unknown
): Promise<{ readonly status: number; readonly data: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = undefined;
  if (text !== "") {
    // An error page (a proxy's HTML 502) is not JSON; its status still has to
    // reach the error message rather than be replaced by a SyntaxError.
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 500);
    }
  }
  return { status: response.status, data };
}

async function githubOk(method: string, path: string, body?: unknown): Promise<unknown> {
  const { status, data } = await github(method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${path} returned HTTP ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

interface WorkflowRunPayload {
  readonly workflow_run: {
    readonly id: number;
    readonly name: string;
    readonly event: string;
    readonly head_branch: string | null;
    readonly head_sha: string;
    readonly conclusion: string | null;
    readonly html_url: string;
    readonly run_number: number;
    readonly run_attempt: number;
    readonly head_repository: { readonly full_name: string } | null;
    readonly repository: { readonly full_name: string };
  };
}

function readRun(): { readonly id: number; readonly run: CompletedRun } {
  const payload = JSON.parse(
    readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8")
  ) as WorkflowRunPayload;
  const wr = payload.workflow_run;
  return {
    id: wr.id,
    run: {
      workflowName: wr.name,
      event: wr.event,
      headBranch: wr.head_branch ?? "",
      headSha: wr.head_sha,
      headRepository: wr.head_repository?.full_name ?? "",
      repository: wr.repository.full_name,
      conclusion: wr.conclusion ?? "",
      url: wr.html_url,
      runNumber: wr.run_number,
      runAttempt: wr.run_attempt,
    },
  };
}

/** Every open issue with the label. The issues endpoint lists pull requests too. */
async function listOpenIssues(): Promise<OpenIssue[]> {
  const issues: OpenIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = (await githubOk(
      "GET",
      `/repos/${REPO}/issues?state=open&labels=${CI_ALERT_LABEL}&per_page=100&page=${page}`
    )) as ReadonlyArray<{
      readonly number: number;
      readonly title: string;
      readonly pull_request?: unknown;
    }>;
    for (const item of batch) {
      if (item.pull_request === undefined) issues.push({ number: item.number, title: item.title });
    }
    if (batch.length < 100) return issues;
  }
}

/** Names of the jobs of this attempt that failed, for the issue body. */
async function listFailedJobs(runId: number, attempt: number): Promise<string[]> {
  const data = (await githubOk(
    "GET",
    `/repos/${REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`
  )) as { readonly jobs: ReadonlyArray<{ readonly name: string; readonly conclusion: string }> };
  return data.jobs
    .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
    .map((job) => job.name);
}

/** Creates the label on first use; 422 means it already exists. */
async function ensureLabel(): Promise<void> {
  const { status, data } = await github("POST", `/repos/${REPO}/labels`, {
    name: CI_ALERT_LABEL,
    color: "b60205",
    description: "A scheduled or main-branch workflow is red; opened and closed by ci-alert.yml",
  });
  if (status !== 201 && status !== 422) {
    throw new Error(
      `Creating label ${CI_ALERT_LABEL} returned HTTP ${status}: ${JSON.stringify(data)}`
    );
  }
}

async function apply(action: AlertAction): Promise<void> {
  switch (action.kind) {
    case "none":
      console.log(`Nothing to do: ${action.reason}.`);
      return;
    case "open": {
      await ensureLabel();
      const created = (await githubOk("POST", `/repos/${REPO}/issues`, {
        title: action.title,
        body: action.body,
        labels: [CI_ALERT_LABEL],
      })) as { readonly html_url: string };
      console.log(`Opened ${created.html_url}`);
      return;
    }
    case "comment":
      await githubOk("POST", `/repos/${REPO}/issues/${action.issue}/comments`, {
        body: action.body,
      });
      console.log(`Commented on #${action.issue}`);
      return;
    case "close":
      for (const issue of action.issues) {
        await githubOk("POST", `/repos/${REPO}/issues/${issue}/comments`, { body: action.body });
        await githubOk("PATCH", `/repos/${REPO}/issues/${issue}`, {
          state: "closed",
          state_reason: "completed",
        });
        console.log(`Closed #${issue}`);
      }
      return;
  }
}

async function main(): Promise<void> {
  const { id, run } = readRun();
  console.log(
    `${run.workflowName} #${run.runNumber} (${run.event} on ${run.headBranch}): ${run.conclusion}`
  );
  // The cheap decision first: a PR run or a cancellation needs no API call.
  const verdict = classifyRun(run);
  if (verdict.kind === "ignore") {
    console.log(`Nothing to do: ${verdict.reason}.`);
    return;
  }

  // The failed jobs only decorate the issue body: a failure listing them must
  // not stop the issue from being opened.
  let failedJobs: string[] = [];
  if (verdict.kind === "red") {
    try {
      failedJobs = await listFailedJobs(id, run.runAttempt);
    } catch (err) {
      console.warn(`Could not list the failed jobs: ${(err as Error).message}`);
    }
  }
  await apply(planAlert(run, await listOpenIssues(), failedJobs));
}

await main();
