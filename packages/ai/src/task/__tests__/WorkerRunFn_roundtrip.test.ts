/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WorkerManager, WorkerServerBase } from "@workglow/util/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("WorkerManager.callWorkerRunFunction round-trip", () => {
  it("WorkerManager + WorkerServerBase exports are available", () => {
    // Smoke import — a full worker round-trip requires a real Worker harness
    // and is validated by provider tests that use workers (HFT in worker mode).
    expect(typeof WorkerManager).toBe("function");
    expect(typeof WorkerServerBase).toBe("function");
  });
});

/**
 * Tests WorkerServerBase.handleRunCall in isolation using a patched
 * globalThis.postMessage to capture outgoing messages. This validates:
 *   1. The terminal message type is "complete" (not "result").
 *   2. outputSchema and sessionId are passed through to the run-fn.
 *   3. emit events arrive as stream_chunk messages before the terminal complete.
 */
describe("WorkerServerBase.handleRunCall protocol", () => {
  const captured: any[] = [];
  let originalPostMessage: typeof globalThis.postMessage | undefined;

  beforeEach(() => {
    captured.length = 0;
    originalPostMessage = (globalThis as any).postMessage;
    (globalThis as any).postMessage = (msg: any) => captured.push(msg);
  });

  afterEach(() => {
    (globalThis as any).postMessage = originalPostMessage;
  });

  it("sends stream_chunk events then a 'complete' terminal message", async () => {
    const server = new WorkerServerBase();
    server.registerRunFunction("test.fn", async (_input, _model, _signal, emit) => {
      void emit({ type: "text-delta", textDelta: "hello" });
      void emit({ type: "finish", data: {} });
    });

    await (server as any).handleRunCall("req-1", "test.fn", [
      "input",
      undefined,
      undefined,
      undefined,
    ]);

    const chunks = captured.filter((m) => m.type === "stream_chunk");
    const complete = captured.find((m) => m.type === "complete");
    const result = captured.find((m) => m.type === "result");

    expect(chunks).toHaveLength(2);
    expect(chunks[0].data).toEqual({ type: "text-delta", textDelta: "hello" });
    expect(chunks[1].data).toEqual({ type: "finish", data: {} });
    expect(complete).toBeDefined();
    expect(complete.id).toBe("req-1");
    expect(complete.data).toBeUndefined();
    // Confirm "result" is NOT the terminal type (was the bug)
    expect(result).toBeUndefined();
  });

  it("passes outputSchema and sessionId to the run-fn", async () => {
    const server = new WorkerServerBase();
    let receivedOutputSchema: unknown;
    let receivedSessionId: unknown;

    server.registerRunFunction(
      "schema.fn",
      async (_input, _model, _signal, emit, outputSchema, sessionId) => {
        receivedOutputSchema = outputSchema;
        receivedSessionId = sessionId;
        void emit({ type: "finish", data: {} });
      }
    );

    const schema = { type: "object", properties: { text: { type: "string" } } };
    await (server as any).handleRunCall("req-2", "schema.fn", [
      "input",
      undefined,
      schema,
      "sess-42",
    ]);

    expect(receivedOutputSchema).toEqual(schema);
    expect(receivedSessionId).toBe("sess-42");
  });

  it("forwards a finish event's `usage` sibling across the worker boundary", async () => {
    // The usage channel needs no protocol change: the whole event object is
    // forwarded, so a sibling field survives structured clone untouched.
    const server = new WorkerServerBase();
    const usage = {
      input: 120,
      output: 45,
      cached: 100,
      cacheWrite: undefined,
      reasoning: undefined,
      total: 165,
      extra: { tier: "standard" },
    };
    server.registerRunFunction("usage.fn", async (_input, _model, _signal, emit) => {
      void emit({ type: "finish", data: {}, usage } as any);
    });

    await (server as any).handleRunCall("req-usage", "usage.fn", [
      "input",
      undefined,
      undefined,
      undefined,
    ]);

    const chunks = captured.filter((m) => m.type === "stream_chunk");
    expect(chunks).toHaveLength(1);
    // Round-trip through structured clone the way postMessage would.
    const roundTripped = structuredClone(chunks[0].data);
    expect(roundTripped.type).toBe("finish");
    expect(roundTripped.data).toEqual({});
    expect(roundTripped.usage).toEqual({
      input: 120,
      output: 45,
      cached: 100,
      cacheWrite: undefined,
      reasoning: undefined,
      total: 165,
      extra: { tier: "standard" },
    });
  });

  it("sends 'error' and no 'complete' when the run-fn throws", async () => {
    const server = new WorkerServerBase();
    server.registerRunFunction("fail.fn", async () => {
      throw new Error("run-fn failed");
    });

    await (server as any).handleRunCall("req-3", "fail.fn", [
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    const error = captured.find((m) => m.type === "error");
    const complete = captured.find((m) => m.type === "complete");

    expect(error).toBeDefined();
    expect(error.data.message).toBe("run-fn failed");
    expect(complete).toBeUndefined();
  });
});
