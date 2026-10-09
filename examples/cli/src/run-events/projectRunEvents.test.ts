/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Task, Workflow, type IExecuteContext } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "./RunEventTypes";
import { projectRunEvents } from "./projectRunEvents";

const EMPTY = { type: "object", properties: {} } as const satisfies DataPortSchema;

class ReportingTask extends Task<Record<string, never>, Record<string, never>> {
  static override readonly type = "ReportingTask";
  static override readonly title = "Reporting task";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return EMPTY;
  }
  static override outputSchema(): DataPortSchema {
    return EMPTY;
  }
  override async execute(_input: Record<string, never>, context: IExecuteContext) {
    await context.updateProgress(42, "halfway");
    return {};
  }
}

function collector(): {
  events: RunEvent[];
  sink: { emit: (e: RunEvent) => void; close: () => Promise<void> };
} {
  const events: RunEvent[] = [];
  return { events, sink: { emit: (e) => events.push(e), close: async () => {} } };
}

describe("projectRunEvents", () => {
  it("reports every task, its statuses and its progress", async () => {
    const { events, sink } = collector();
    const workflow = new Workflow();
    workflow.pipe(new ReportingTask() as never);
    const stop = projectRunEvents(workflow.graph, sink);
    await workflow.run({});
    stop();

    const added = events.filter((e) => e.k === "task_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "ReportingTask", label: "Reporting task", depth: 0 });
    const statuses = events.flatMap((e) => (e.k === "status" ? [e.status] : []));
    expect(statuses).toContain("PROCESSING");
    expect(statuses).toContain("COMPLETED");
    expect(events.some((e) => e.k === "progress" && e.progress === 42)).toBe(true);
  });

  it("stops emitting once unsubscribed", async () => {
    const { events, sink } = collector();
    const workflow = new Workflow();
    workflow.pipe(new ReportingTask() as never);
    const stop = projectRunEvents(workflow.graph, sink);
    stop();
    await workflow.run({});
    expect(events.filter((e) => e.k === "status")).toHaveLength(0);
  });
});

const STREAMED_PORTS = {
  type: "object",
  properties: {
    text: { type: "string", "x-stream": "append" },
    reasoning: { type: "string", "x-stream": "append" },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/** Streams a reply beside its reasoning, as `AgentTask` does. */
class ThinkingTask extends Task<Record<string, never>, { text: string; reasoning: string }> {
  static override readonly type = "ThinkingTask";
  static override readonly title = "Thinking task";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return EMPTY;
  }
  static override outputSchema(): DataPortSchema {
    return STREAMED_PORTS;
  }
  async *executeStream() {
    yield { type: "text-delta" as const, port: "reasoning", textDelta: "Let me think." };
    yield { type: "text-delta" as const, port: "text", textDelta: "Hello." };
    yield { type: "finish" as const, data: {} as { text: string; reasoning: string } };
  }
}

describe("projectRunEvents streamed text", () => {
  it("reports a task's text, not the reasoning it streams beside it", async () => {
    const { events, sink } = collector();
    const workflow = new Workflow();
    workflow.pipe(new ThinkingTask() as never);
    const stop = projectRunEvents(workflow.graph, sink);
    await workflow.run({});
    stop();

    const deltas = events.flatMap((e) => (e.k === "text" ? [e.delta] : []));
    expect(deltas).toEqual(["Hello."]);
  });
});

const ITEM_SCHEMA = {
  type: "object",
  properties: { item: { type: "number" } },
  required: ["item"],
  additionalProperties: true,
} as const satisfies DataPortSchema;

/** The innermost work — what a sweep is actually doing, and what must be reported. */
class LeafWorkTask extends Task<{ item: number }, Record<string, never>> {
  static override readonly type = "LeafWorkTask";
  static override readonly title = "Leaf work";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return ITEM_SCHEMA;
  }
  static override outputSchema(): DataPortSchema {
    return EMPTY;
  }
  override async execute() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {};
  }
}

/** Owns its real work, the way the sweep tasks do via `context.own`. */
class OwningTask extends Task<{ item: number }, Record<string, never>> {
  static override readonly type = "OwningTask";
  static override readonly title = "Owning task";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return ITEM_SCHEMA;
  }
  static override outputSchema(): DataPortSchema {
    return EMPTY;
  }
  override async execute(input: { item: number }, context: IExecuteContext) {
    const child = context.own(new LeafWorkTask());
    await child.run(input, { signal: context.signal });
    return {};
  }
}

describe("projectRunEvents subtrees", () => {
  it("reports the tasks a running task owns, which do not exist when its row is made", async () => {
    const { events, sink } = collector();
    const workflow = new Workflow();
    workflow.pipe(new OwningTask() as never);
    const stop = projectRunEvents(workflow.graph, sink);
    await workflow.run({ item: 1 });
    stop();

    const owner = events.find((e) => e.k === "task_added" && e.type === "OwningTask");
    const leaf = events.find((e) => e.k === "task_added" && e.type === "LeafWorkTask");
    expect(owner).toBeDefined();
    // The whole bug: a subgraph is empty when its parent's row is created, so a
    // one-shot read reported nothing beneath it.
    expect(leaf).toBeDefined();
    expect(leaf).toMatchObject({ depth: 1, parent: (owner as { id: string }).id });
  });

  it("reports a map's live iteration work, and releases each clone's rows when it finishes", async () => {
    const { events, sink } = collector();
    const workflow = new Workflow();
    workflow.map({ concurrencyLimit: 1, maxIterations: 2 }).addTask(LeafWorkTask).endMap();
    const stop = projectRunEvents(workflow.graph, sink);
    await workflow.run({ item: [1, 2] });
    stop();

    const mapRow = events.find((e) => e.k === "task_added" && e.depth === 0);
    const clones = events.filter((e) => e.k === "task_added" && e.type === "LeafWorkTask");
    // A Map's own subgraph is the idle template; the running work lives in the
    // per-iteration clones, so reporting the template shows an empty parent.
    expect(clones.length).toBeGreaterThan(0);
    expect(clones[0]).toMatchObject({ depth: 1, parent: (mapRow as { id: string }).id });

    // Rows for a finished iteration are withdrawn: a worklist of thousands must
    // not leave a row per item behind.
    const removed = new Set(events.flatMap((e) => (e.k === "task_removed" ? [e.id] : [])));
    for (const clone of clones) expect(removed.has((clone as { id: string }).id)).toBe(true);
  });
});
