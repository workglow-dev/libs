/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which stream events are a task's own reporting rather than content on a port.
 *
 * `StreamPump` asks this before enqueueing onto a dataflow edge. The port filter
 * beside it cannot answer: it recognises only the three delta types, so an event
 * carrying no `port` passes it by construction and would reach an edge unless
 * named here. Two things go wrong when one does — a nested graph re-yields it
 * under a second task id, reporting the same thing twice under different names,
 * and `streamEventCost` charges it nothing, so an event carrying a whole tool
 * result passes the backpressure gate uncounted.
 */

import type { StreamEvent } from "@workglow/task-graph";
import { isDataflowExcluded, streamEventCost } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

describe("isDataflowExcluded", () => {
  it("excludes a task's own reporting", () => {
    expect(isDataflowExcluded({ type: "phase", message: "Thinking", progress: undefined })).toBe(
      true
    );
    for (const event of [
      { type: "tool-call", status: "pending", toolCallId: "c1", name: "t", input: {} },
      { type: "tool-call", status: "running", toolCallId: "c1", name: "t" },
      { type: "tool-call", status: "completed", toolCallId: "c1", name: "t", result: "ok" },
      { type: "tool-call", status: "failed", toolCallId: "c1", name: "t", result: "no" },
    ] as StreamEvent[]) {
      expect(isDataflowExcluded(event)).toBe(true);
    }
  });

  it("passes content and the control events a downstream consumer reads", () => {
    for (const event of [
      { type: "text-delta", port: "text", textDelta: "hi" },
      { type: "object-delta", port: "o", objectDelta: { a: 1 } },
      { type: "binary-delta", port: "b", binaryDelta: new Uint8Array([1]) },
      { type: "snapshot", data: {} },
      { type: "finish", data: {} },
      { type: "error", error: new Error("x") },
    ] as StreamEvent[]) {
      expect(isDataflowExcluded(event)).toBe(false);
    }
  });

  it("excludes exactly the events the backpressure gate cannot price", () => {
    // The two rules have to agree: an event the gate charges nothing for and
    // that still reached an edge would accumulate without the gate closing.
    // Every zero-cost event here is either excluded or bounded in size.
    const settled: StreamEvent = {
      type: "tool-call",
      status: "completed",
      toolCallId: "c1",
      name: "t",
      result: "x".repeat(20_000),
    };
    expect(streamEventCost(settled)).toBe(0);
    expect(isDataflowExcluded(settled)).toBe(true);
  });
});
