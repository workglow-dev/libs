/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { evaluateCiRuns, evaluateNightlyGuard, type WorkflowRun } from "./lib/ciGate";

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  databaseId: 1,
  status: "completed",
  conclusion: "success",
  url: "https://github.com/workglow-dev/libs/actions/runs/1",
  ...over,
});

const SHA = "fb861bb0000000000000000000000000000000aa";

describe("evaluateCiRuns", () => {
  it("passes a completed, successful run", () => {
    expect(evaluateCiRuns([run()], SHA).ok).toBe(true);
  });

  it("refuses a commit with no run at all", () => {
    // The state a brand-new commit is in, and the one the gate exists for: the
    // release would publish code no workflow has ever built.
    const verdict = evaluateCiRuns([], SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/No .Build & Test. run found/);
  });

  it("refuses a run still in flight rather than reading it as a failure", () => {
    // An in-flight run carries an empty conclusion. Reporting that as
    // 'concluded ""' would send the publisher looking for a failure that has
    // not happened.
    const verdict = evaluateCiRuns([run({ status: "in_progress", conclusion: "" })], SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("still in_progress");
  });

  it("refuses a failed run and names it", () => {
    const verdict = evaluateCiRuns([run({ conclusion: "failure" })], SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('concluded "failure"');
    expect(verdict.ok === false && verdict.reason).toContain("actions/runs/1");
  });

  it("refuses a cancelled run", () => {
    expect(evaluateCiRuns([run({ conclusion: "cancelled" })], SHA).ok).toBe(false);
  });

  describe("when a commit carries several runs", () => {
    // `gh run list` returns newest first.
    it("takes the newest, so a green re-run clears an earlier red", () => {
      const verdict = evaluateCiRuns(
        [run({ databaseId: 2 }), run({ databaseId: 1, conclusion: "failure" })],
        SHA
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.ok === true && verdict.run.databaseId).toBe(2);
    });

    it("takes the newest, so a red re-run is not papered over by the green it replaced", () => {
      const verdict = evaluateCiRuns(
        [run({ databaseId: 2, conclusion: "failure" }), run({ databaseId: 1 })],
        SHA
      );
      expect(verdict.ok).toBe(false);
    });
  });
});

describe("evaluateNightlyGuard", () => {
  const GUARD = "nightly-typecheck.yml";
  const LIMIT = 30;

  it("passes when the latest run is green", () => {
    expect(evaluateNightlyGuard([run(), run({ conclusion: "failure" })], GUARD, LIMIT).ok).toBe(true);
  });

  it("refuses when the latest run is red, naming it and how to re-run the guard", () => {
    const verdict = evaluateNightlyGuard([run({ conclusion: "failure" }), run()], GUARD, LIMIT);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("actions/runs/1");
    expect(verdict.ok === false && verdict.reason).toContain(`gh workflow run ${GUARD}`);
  });

  it("reads past a run in flight or cancelled to the newest that finished", () => {
    // Neither says whether main is broken; skipping them for the last verdict
    // is what keeps a cancelled re-run from hiding a red night.
    const runs = [
      run({ status: "in_progress", conclusion: "" }),
      run({ conclusion: "cancelled" }),
      run({ conclusion: "failure" }),
    ];
    expect(evaluateNightlyGuard(runs, GUARD, LIMIT).ok).toBe(false);
  });

  it("refuses nothing when the guard has never finished a run", () => {
    const verdict = evaluateNightlyGuard([], GUARD, LIMIT);
    expect(verdict).toEqual({ ok: true, run: undefined });
  });

  it("refuses a full page with no finished run, which hides the run that decides it", () => {
    const runs = [
      run({ status: "in_progress", conclusion: "" }),
      run({ conclusion: "cancelled" }),
      run({ conclusion: "cancelled" }),
    ];
    const verdict = evaluateNightlyGuard(runs, GUARD, runs.length);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/None of the latest 3/);
    expect(evaluateNightlyGuard(runs, GUARD, runs.length + 1)).toEqual({
      ok: true,
      run: undefined,
    });
  });
});
