/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

import { isOpaqueToPeer } from "../streamProjection";

describe("isOpaqueToPeer", () => {
  it("hides which tool is running", () => {
    // A2A peers are opaque to each other: a caller sees messages, status and
    // artifacts, never the callee's tools. These same events are what ACP and
    // builder's cards are built on, which is why the filter is per-protocol
    // and not a property of the event.
    const event = {
      type: "tool-call",
      status: "running",
      toolCallId: "c1",
      name: "fetch_url",
    } as StreamEvent;
    expect(isOpaqueToPeer(event)).toBe(true);
  });

  it("hides a whole-transcript snapshot", () => {
    expect(isOpaqueToPeer({ type: "snapshot", data: {} } as StreamEvent)).toBe(true);
  });

  it("lets the answer through", () => {
    expect(isOpaqueToPeer({ type: "text-delta", text: "hi" } as StreamEvent)).toBe(false);
    expect(isOpaqueToPeer({ type: "finish", data: {} } as StreamEvent)).toBe(false);
  });

  it("lets a stage label through, since it names no tool", () => {
    expect(
      isOpaqueToPeer({ type: "phase", message: "Generating", progress: undefined } as StreamEvent)
    ).toBe(false);
  });
});
