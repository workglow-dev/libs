// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { Task } from "@workglow/task-graph";
import { ReactFlowProvider } from "@xyflow/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskNode } from "./TaskNode";

const SCHEMA = { type: "object", properties: {} } as never;

class NoopTask extends Task<Record<string, never>, Record<string, never>> {
  static override readonly type = "NoopTask";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): never {
    return SCHEMA;
  }
  static override outputSchema(): never {
    return SCHEMA;
  }
  override async execute() {
    return {};
  }
}

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cached: undefined,
  cacheWrite: undefined,
  reasoning: undefined,
  total: undefined,
  extra: undefined,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
});

function renderTaskNode(usageValue: Usage | undefined, task: Task = new NoopTask()): void {
  act(() => {
    root = createRoot(container);
  });
  rerenderTaskNode(usageValue, task);
}

/** Renders into the existing root, as ReactFlow does when it reuses a node for another task. */
function rerenderTaskNode(usageValue: Usage | undefined, task: Task): void {
  const nodeProps = {
    id: String(task.id),
    type: "task",
    data: { task, usage: usageValue },
    selected: false,
    isConnectable: true,
    zIndex: 0,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragHandle: undefined,
    parentId: undefined,
    width: 200,
    height: 100,
  };

  act(() => {
    root.render(
      createElement(ReactFlowProvider, null, createElement(TaskNode, nodeProps as never))
    );
  });
}

describe("TaskNode per-node usage badge (the node actually rendered on the graph)", () => {
  it("renders the node's cumulative token badge when usage is present", () => {
    renderTaskNode(usage(250, 75));
    const badge = container.querySelector(".task-node-usage");
    expect(badge?.textContent).toBe("↑250 ↓75");
  });

  it("renders no usage badge when the node has reported nothing", () => {
    renderTaskNode(undefined);
    expect(container.querySelector(".task-node-usage")).toBeNull();
  });
});

describe("TaskNode streaming panel", () => {
  const delta = (port: string | undefined, textDelta: string) =>
    port === undefined
      ? { type: "text-delta" as const, textDelta }
      : { type: "text-delta" as const, port, textDelta };

  it("shows reasoning in its own subdued block, above the answer", () => {
    const task = new NoopTask();
    renderTaskNode(undefined, task);
    act(() => {
      task.emit("stream_start");
      task.emit("stream_chunk", delta("reasoning", "Weighing it.") as never);
      task.emit("stream_chunk", delta("text", "The answer.") as never);
    });

    const reasoning = container.querySelector("details.task-node-reasoning");
    expect(reasoning?.textContent).toContain("Weighing it.");
    expect(reasoning?.textContent).not.toContain("The answer.");

    const answer = [...container.querySelectorAll("pre")].find((pre) => !reasoning?.contains(pre));
    expect(answer?.textContent).toBe("The answer.");
    expect(
      reasoning!.compareDocumentPosition(answer!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("drops the previous task's stream when the node is reused for another task", () => {
    const first = new NoopTask();
    renderTaskNode(undefined, first);
    act(() => {
      first.emit("stream_start");
      first.emit("stream_chunk", delta("reasoning", "First task's thinking.") as never);
      first.emit("stream_chunk", delta("text", "First answer.") as never);
    });
    expect(container.textContent).toContain("First task's thinking.");

    rerenderTaskNode(undefined, new NoopTask());
    expect(container.textContent).not.toContain("First task's thinking.");
    expect(container.textContent).not.toContain("First answer.");
  });

  it("treats a delta with no port as the answer", () => {
    const task = new NoopTask();
    renderTaskNode(undefined, task);
    act(() => {
      task.emit("stream_start");
      task.emit("stream_chunk", delta(undefined, "plain") as never);
    });
    expect(container.querySelector("details.task-node-reasoning")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("plain");
  });

  it("draws no reasoning block for a task that sends none", () => {
    const task = new NoopTask();
    renderTaskNode(undefined, task);
    act(() => {
      task.emit("stream_start");
      task.emit("stream_chunk", delta("text", "only answer") as never);
    });
    expect(container.querySelector("details.task-node-reasoning")).toBeNull();
  });
});
