/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the credit-window backpressure on a worker's run-call path.
 *
 * A message port has no natural backpressure: `postMessage` always accepts, so
 * a worker producing faster than the main thread consumes does not slow down —
 * it relocates its backlog into the caller's memory. The window is what makes
 * a stream across the boundary behave like the in-process one, and the
 * property worth pinning is that the producer actually *parks*, not merely
 * that credits are exchanged.
 */

import { streamChunkCost, WorkerServerBase } from "@workglow/util/worker";
import { describe, expect, it } from "vitest";

interface Posted {
  readonly type: string;
  readonly id?: string;
  readonly data?: unknown;
}

/** A server whose replies land in an array instead of on a port. */
function serverWithCapture(): { server: WorkerServerBase; posted: Posted[] } {
  const posted: Posted[] = [];
  const server = new WorkerServerBase({
    post: (message: unknown) => {
      posted.push(message as Posted);
    },
  });
  return { server, posted };
}

const callRun = (id: string, functionName: string, creditWindow?: number) => ({
  type: "message",
  data: {
    id,
    type: "call",
    functionName,
    args: [{}, undefined, undefined, undefined],
    run: true,
    creditWindow,
  },
});

const credit = (id: string, cost: number) => ({
  type: "message",
  data: { id, type: "stream_credit", cost },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("run-call backpressure", () => {
  it("parks the producer once the window is full, and resumes on credit", async () => {
    const { server, posted } = serverWithCapture();

    const event = { type: "text-delta", port: "out", textDelta: "0123456789" };
    // Cost counts every string the event carries, not just the payload one, so
    // it is computed rather than hand-counted — the window is a throttle, and
    // the exact unit only has to be proportional and consistent across sides.
    const cost = streamChunkCost(event);

    let emitted = 0;
    let finished = false;
    server.registerRunFunction(
      "emitFive",
      async (_input, _model, _signal, emit: (event: unknown) => void | Promise<void>) => {
        for (let i = 0; i < 5; i++) {
          await emit(event);
          emitted++;
        }
        finished = true;
      }
    );

    const done = server.handleMessage(callRun("r1", "emitFive", cost));
    await settle();

    // One chunk is out and the window is full: the producer is parked rather
    // than racing ahead into the caller's memory.
    expect(emitted).toBe(0);
    expect(posted.filter((m) => m.type === "stream_chunk")).toHaveLength(1);
    expect(finished).toBe(false);

    // Consuming that chunk reopens the window for exactly one more.
    await server.handleMessage(credit("r1", cost));
    await settle();
    expect(posted.filter((m) => m.type === "stream_chunk")).toHaveLength(2);
    expect(finished).toBe(false);

    // Credit the rest; the run drains and completes.
    for (let i = 0; i < 4; i++) {
      await server.handleMessage(credit("r1", cost));
      await settle();
    }
    await done;
    expect(finished).toBe(true);
    expect(posted.filter((m) => m.type === "stream_chunk")).toHaveLength(5);
  });

  it("does not park at all when no window was opened", async () => {
    const { server, posted } = serverWithCapture();

    let finished = false;
    server.registerRunFunction(
      "emitMany",
      async (_input, _model, _signal, emit: (event: unknown) => void | Promise<void>) => {
        for (let i = 0; i < 20; i++) {
          await emit({ type: "text-delta", port: "out", textDelta: "0123456789" });
        }
        finished = true;
      }
    );

    // No creditWindow: a caller on the older protocol sends no credits, so a
    // gate here would park the producer forever.
    await server.handleMessage(callRun("r2", "emitMany"));

    expect(finished).toBe(true);
    expect(posted.filter((m) => m.type === "stream_chunk")).toHaveLength(20);
  });

  it("releases a parked producer when the request is aborted", async () => {
    const { server } = serverWithCapture();

    let released = false;
    server.registerRunFunction(
      "emitForever",
      async (_input, _model, _signal, emit: (event: unknown) => void | Promise<void>) => {
        await emit({ type: "text-delta", port: "out", textDelta: "0123456789" });
        // Reached only if the park is released rather than waiting on a credit
        // the caller has stopped sending.
        released = true;
      }
    );

    const done = server.handleMessage(callRun("r3", "emitForever", 5));
    await settle();
    expect(released).toBe(false);

    await server.handleMessage({ type: "message", data: { id: "r3", type: "abort" } });
    await settle();
    await done;

    expect(released).toBe(true);
  });
});
