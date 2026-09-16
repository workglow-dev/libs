/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Task,
  TaskAbortedError,
  TaskGraph,
  Workflow,
  type IExecuteContext,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installRunEventChannel,
  resetRunEventChannelForTesting,
  RUN_EVENTS_ENV,
} from "../run-events/runEventChannel";
import { resetRunReportingForTesting } from "../run-events/runReporting";
import { withCli } from "../run-interactive";

const EMPTY = { type: "object", properties: {} } as const satisfies DataPortSchema;

class HangingTask extends Task<Record<string, never>, Record<string, never>> {
  static override readonly type = "HangingTask";
  static override readonly title = "Hanging task";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return EMPTY;
  }
  static override outputSchema(): DataPortSchema {
    return EMPTY;
  }

  started!: () => void;

  override async execute(
    _input: Record<string, never>,
    context: IExecuteContext
  ): Promise<Record<string, never>> {
    await new Promise<void>((_resolve, reject) => {
      const fail = (): void => {
        reject(new TaskAbortedError());
      };
      if (context.signal.aborted) {
        fail();
        return;
      }
      context.signal.addEventListener("abort", fail, { once: true });
      this.started();
    });
    return {};
  }
}

class QuietTask extends Task<Record<string, never>, Record<string, never>> {
  static override readonly type = "QuietAbortProbeTask";
  static override readonly title = "Quiet abort probe";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return EMPTY;
  }
  static override outputSchema(): DataPortSchema {
    return EMPTY;
  }
  override async execute(): Promise<Record<string, never>> {
    return {};
  }
}

function hangingTask(): { task: HangingTask; started: Promise<void> } {
  const task = new HangingTask();
  const started = new Promise<void>((resolve) => {
    task.started = resolve;
  });
  return { task, started };
}

afterEach(() => {
  resetRunEventChannelForTesting();
  resetRunReportingForTesting();
  delete process.env[RUN_EVENTS_ENV];
});

describe("withCli process-signal abort", { timeout: 5_000 }, () => {
  it("aborts a hanging task on SIGINT", async () => {
    const { task, started } = hangingTask();
    const run = withCli(task as never, { interactive: false }).run({});
    await started;
    process.emit("SIGINT");
    await expect(run).rejects.toBeInstanceOf(TaskAbortedError);
  });

  it("aborts a hanging graph on SIGINT", async () => {
    const { task, started } = hangingTask();
    const graph = new TaskGraph();
    graph.addTask(task);
    const run = withCli(graph, { interactive: false }).run({});
    await started;
    process.emit("SIGINT");
    await expect(run).rejects.toBeInstanceOf(TaskAbortedError);
  });

  it("aborts a hanging workflow on SIGINT", async () => {
    const { task, started } = hangingTask();
    const workflow = new Workflow();
    workflow.pipe(task as never);
    const run = withCli(workflow, { interactive: false }).run({});
    await started;
    process.emit("SIGINT");
    await expect(run).rejects.toBeInstanceOf(TaskAbortedError);
  });

  it("aborts a hanging task on SIGTERM", async () => {
    const { task, started } = hangingTask();
    const run = withCli(task as never, { interactive: false }).run({});
    await started;
    process.emit("SIGTERM");
    await expect(run).rejects.toBeInstanceOf(TaskAbortedError);
  });

  it("reports the run as aborted when a parent is watching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-withcli-abort-"));
    const file = join(dir, "events.ndjson");
    installRunEventChannel(`file:${file}`);
    const { task, started } = hangingTask();
    const run = withCli(task as never, { interactive: false }).run({});
    await started;
    process.emit("SIGINT");
    await expect(run).rejects.toBeInstanceOf(TaskAbortedError);
    const last = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .at(-1);
    expect(last).toMatchObject({ k: "run_end", state: "aborted" });
  });

  it("does not leave SIGINT listeners after the run finishes", async () => {
    const before = process.listenerCount("SIGINT");
    await withCli(new QuietTask() as never, { interactive: false }).run({});
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
