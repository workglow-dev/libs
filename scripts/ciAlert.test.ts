/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompletedRun, OpenIssue } from "./lib/ciAlert";
import { classifyRun, issueTitle, planAlert } from "./lib/ciAlert";

const run = (over: Partial<CompletedRun> = {}): CompletedRun => ({
  workflowName: "Nightly type-drift guard",
  event: "schedule",
  headBranch: "main",
  headSha: "deb773b9e0000000000000000000000000000000",
  headRepository: "workglow-dev/libs",
  repository: "workglow-dev/libs",
  conclusion: "failure",
  url: "https://github.com/workglow-dev/libs/actions/runs/42",
  runNumber: 131,
  runAttempt: 1,
  ...over,
});

const tracking = (number: number, workflowName = "Nightly type-drift guard"): OpenIssue => ({
  number,
  title: issueTitle(workflowName),
});

describe("classifyRun", () => {
  it.each(["failure", "timed_out", "startup_failure"])("reads %s as red", (conclusion) => {
    expect(classifyRun(run({ conclusion })).kind).toBe("red");
  });

  it("reads success as green", () => {
    expect(classifyRun(run({ conclusion: "success" })).kind).toBe("green");
  });

  it.each(["cancelled", "skipped", "neutral", "action_required", "stale", ""])(
    "ignores %j: it says nothing about the code",
    (conclusion) => {
      // `Build & Test` cancels an in-flight main run when the next push lands;
      // closing an issue on that would report a fix nobody made.
      expect(classifyRun(run({ conclusion })).kind).toBe("ignore");
    }
  );

  it.each(["push", "schedule", "workflow_dispatch"])("counts a %s run on main", (event) => {
    expect(classifyRun(run({ event })).kind).toBe("red");
  });

  it("never alerts on a pull_request run, whatever branch it reports", () => {
    expect(classifyRun(run({ event: "pull_request" })).kind).toBe("ignore");
    expect(classifyRun(run({ event: "pull_request", conclusion: "success" })).kind).toBe("ignore");
  });

  it("ignores a push to another branch", () => {
    expect(classifyRun(run({ event: "push", headBranch: "feature" })).kind).toBe("ignore");
  });

  it("ignores a fork's own main", () => {
    // `head_branch` is only a name; a fork's `main` reports it too.
    expect(classifyRun(run({ event: "push", headRepository: "someone/libs" })).kind).toBe("ignore");
  });
});

describe("planAlert", () => {
  it("opens one issue on the first failure, naming the run", () => {
    const action = planAlert(run(), [], ["type-drift"]);
    expect(action.kind).toBe("open");
    if (action.kind !== "open") return;
    expect(action.title).toBe("CI red on main: Nightly type-drift guard");
    expect(action.body).toContain("https://github.com/workglow-dev/libs/actions/runs/42");
    expect(action.body).toContain("deb773b9e0000000000000000000000000000000");
    expect(action.body).toContain("`failure`");
    expect(action.body).toContain("`type-drift`");
  });

  it("comments on the open issue rather than opening a second", () => {
    const action = planAlert(run({ runNumber: 132 }), [tracking(7)]);
    expect(action).toMatchObject({ kind: "comment", issue: 7 });
    expect(action.kind === "comment" && action.body).toContain("actions/runs/42");
  });

  it("closes the open issue on the next success", () => {
    const action = planAlert(run({ conclusion: "success" }), [tracking(7)]);
    expect(action).toMatchObject({ kind: "close", issues: [7] });
  });

  it("does nothing on a success with no issue open", () => {
    expect(planAlert(run({ conclusion: "success" }), []).kind).toBe("none");
  });

  it("does nothing for an ignored run, even with an issue open", () => {
    expect(planAlert(run({ conclusion: "cancelled" }), [tracking(7)]).kind).toBe("none");
    expect(planAlert(run({ event: "pull_request" }), [tracking(7)]).kind).toBe("none");
  });

  it("keeps workflows apart: another workflow's issue is neither commented on nor closed", () => {
    const others = [tracking(3, "Build & Test"), tracking(4, "Nightly type-drift guard (old)")];
    expect(planAlert(run(), others).kind).toBe("open");
    expect(planAlert(run({ conclusion: "success" }), others).kind).toBe("none");
  });

  it("converges on one issue if two were ever open", () => {
    expect(planAlert(run(), [tracking(9), tracking(5)])).toMatchObject({
      kind: "comment",
      issue: 5,
    });
    expect(planAlert(run({ conclusion: "success" }), [tracking(9), tracking(5)])).toMatchObject({
      kind: "close",
      issues: [5, 9],
    });
  });

  it("walks the whole lifecycle with exactly one issue open while red", () => {
    let open: OpenIssue[] = [];
    let next = 1;
    const step = (conclusion: string): string => {
      const action = planAlert(run({ conclusion }), open);
      if (action.kind === "open") open = [...open, { number: next++, title: action.title }];
      if (action.kind === "close") open = open.filter((i) => !action.issues.includes(i.number));
      return action.kind;
    };
    expect(step("failure")).toBe("open");
    expect(step("failure")).toBe("comment");
    expect(step("cancelled")).toBe("none");
    expect(step("timed_out")).toBe("comment");
    expect(open).toHaveLength(1);
    expect(step("success")).toBe("close");
    expect(open).toHaveLength(0);
    expect(step("success")).toBe("none");
    expect(step("failure")).toBe("open");
    expect(open).toHaveLength(1);
  });
});

describe("ci-alert.yml watches the right workflows", () => {
  // `workflow_run` matches by `name:`, so a rename silently stops a workflow's
  // alerts; and a new scheduled workflow is exactly the kind nobody watches.
  const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  const workflows = readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => {
      const source = readFileSync(join(dir, file), "utf8");
      return {
        file,
        source,
        name: /^name:\s*(.+?)\s*$/m.exec(source)?.[1],
        scheduled: /^\s+schedule:\s*$/m.test(source),
      };
    });

  const alert = workflows.find((w) => w.file === "ci-alert.yml");
  const watched = (() => {
    const block = /^\s+workflows:\s*\n((?:\s+-\s+.+\n)+)/m.exec(alert?.source ?? "")?.[1] ?? "";
    return block
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter((line) => line !== "");
  })();

  it("lists at least the workflows the alert exists for", () => {
    expect(watched).toEqual(expect.arrayContaining(["Build & Test", "Nightly type-drift guard"]));
  });

  it("lists only names some workflow actually has", () => {
    const names = new Set(workflows.map((w) => w.name));
    expect(watched.filter((name) => !names.has(name))).toEqual([]);
  });

  it("lists every schedule-triggered workflow", () => {
    const unwatched = workflows
      .filter((w) => w.scheduled && w.name !== undefined && !watched.includes(w.name))
      .map((w) => w.file);
    expect(unwatched).toEqual([]);
  });
});
