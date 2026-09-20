/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives {@link WorkerSubGraphDispatcher} over a real worker thread.
 *
 * The in-process suite (`SubGraphDispatch.test.ts`) proves the runner's
 * decision logic and that `runSubGraphRequest` rebuilds and runs a graph. What
 * it cannot prove is that the request actually survives a thread boundary —
 * `structuredClone` is forgiving in-process in ways `postMessage` is not, and
 * progress, abort and error rehydration are all manager-level behaviours that
 * only exist once a real thread is on the other end.
 *
 * See `subgraphWorker.fixture.mjs` for why the far end is a hand-rolled
 * protocol speaker rather than a real graph runner.
 */

import type { IExecuteContext, SubGraphRunRequest } from "@workglow/task-graph";
import {
  SUBGRAPH_WORKER_FUNCTION,
  Task,
  TaskRegistry,
  Workflow,
  WorkerSubGraphDispatcher,
} from "@workglow/task-graph";
import { ServiceRegistry, WORKER_MANAGER, Worker, WorkerManager } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const fixtureUrl = new URL("./subgraphWorker.fixture.mjs", import.meta.url);

class WireProbeTask extends Task<{ value: number }, { doubled: number }> {
  public static override type = "WireProbe";
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { value: { type: "number" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { doubled: { type: "number" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { value: number }, _ctx: IExecuteContext) {
    return { doubled: (input.value ?? 0) * 2 };
  }
}

TaskRegistry.registerTask(WireProbeTask);
afterAll(() => TaskRegistry.unregisterTask(WireProbeTask.type));

let manager: WorkerManager | undefined;

function dispatcherOverRealWorker(creditWindow?: number): WorkerSubGraphDispatcher {
  manager = new WorkerManager();
  manager.registerWorker("subgraph-fixture", () => new Worker(fixtureUrl, { type: "module" }));
  const registry = new ServiceRegistry();
  registry.registerInstance(WORKER_MANAGER, manager);
  return creditWindow === undefined
    ? new WorkerSubGraphDispatcher("subgraph-fixture", registry)
    : new WorkerSubGraphDispatcher("subgraph-fixture", registry, creditWindow);
}

/** A real serialized subgraph, so what crosses is what a MapTask would send. */
function probeRequest(input: Record<string, unknown>): SubGraphRunRequest {
  const wf = new Workflow();
  wf.pipe(new WireProbeTask());
  return { graph: wf.graph.toJSON(), input };
}

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

describe("WorkerSubGraphDispatcher over a real worker thread", () => {
  it("names the function the protocol fixes", () => {
    expect(SUBGRAPH_WORKER_FUNCTION).toBe("runSubGraph");
  });

  it("carries a serialized subgraph across the boundary intact", async () => {
    const dispatcher = dispatcherOverRealWorker();

    const results = await dispatcher.runSubGraph(probeRequest({ value: 21 }));

    // The fixture echoes the request's shape back, so this asserts the graph
    // arrived as a graph — not that something merely round-tripped.
    expect(results[0]).toMatchObject({
      data: {
        taskCount: 1,
        taskTypes: [WireProbeTask.type],
        echoedInput: { value: 21 },
      },
    });
  });

  it("forwards progress from the worker to the caller", async () => {
    const dispatcher = dispatcherOverRealWorker();
    const seen: Array<{ progress: number | undefined; message?: string }> = [];

    await dispatcher.runSubGraph(probeRequest({ value: 1 }), {
      onProgress: (progress, message) => seen.push({ progress, message }),
    });

    expect(seen).toContainEqual({ progress: 50, message: "halfway through the subgraph" });
  });

  it("rehydrates a remote throw as an Error on this side", async () => {
    const dispatcher = dispatcherOverRealWorker();

    await expect(dispatcher.runSubGraph(probeRequest({ mode: "boom" }))).rejects.toThrow(
      "subgraph exploded in the worker"
    );
  });

  it("forwards an abort to the worker rather than leaving it running", async () => {
    const dispatcher = dispatcherOverRealWorker();
    const controller = new AbortController();

    // Abort once the worker says it has the request. Aborting any earlier
    // races the manager's own listener attachment, which happens only after
    // the worker handshake completes.
    const pending = dispatcher.runSubGraph(probeRequest({ mode: "hang" }), {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(pending).rejects.toThrow("aborted by caller");
  });

  it("honours a signal that was already aborted before the call", async () => {
    const dispatcher = dispatcherOverRealWorker();

    // The window this covers is real: the manager awaits worker startup before
    // attaching its abort listener, and `addEventListener` on an
    // already-aborted signal never fires — so without an explicit check the
    // work runs to completion in the worker with nothing awaiting it.
    const pending = dispatcher.runSubGraph(probeRequest({ mode: "hang" }), {
      signal: AbortSignal.abort(),
    });

    await expect(pending).rejects.toThrow("aborted by caller");
  });

  it("names the worker when the manager has no such registration", async () => {
    const registry = new ServiceRegistry();
    registry.registerInstance(WORKER_MANAGER, new WorkerManager());
    const dispatcher = new WorkerSubGraphDispatcher("nowhere", registry);

    await expect(dispatcher.runSubGraph(probeRequest({ value: 1 }))).rejects.toThrow(/nowhere/);
  });
});

describe("runSubGraphStream over a real worker thread", () => {
  it("delivers chunks incrementally, then the terminal results", async () => {
    const dispatcher = dispatcherOverRealWorker();

    const kinds: string[] = [];
    const deltas: string[] = [];
    for await (const item of dispatcher.runSubGraphStream!(probeRequest({ count: 5 }))) {
      kinds.push(item.kind);
      if (item.kind === "chunk") {
        deltas.push((item.chunk.event as { textDelta: string }).textDelta);
      }
    }

    expect(kinds.slice(0, -1).every((k) => k === "chunk")).toBe(true);
    expect(kinds[kinds.length - 1]).toBe("results");
    expect(deltas).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("paces the worker to the consumer across the thread boundary", async () => {
    // A tiny window against many chunks: unbounded forwarding would let the
    // worker emit all of them before this slow consumer took the first.
    const dispatcher = dispatcherOverRealWorker(24);

    let results: { maxAhead: number; count: number } | undefined;
    for await (const item of dispatcher.runSubGraphStream!(probeRequest({ count: 20 }))) {
      if (item.kind === "results") {
        results = (item.results[0] as { data: { maxAhead: number; count: number } }).data;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(results?.count).toBe(20);
    // The worker's own high-water mark of uncredited items. Small means the
    // credit window actually throttled it; 20 would mean nothing did.
    expect(results?.maxAhead).toBeGreaterThan(0);
    expect(results?.maxAhead).toBeLessThan(5);
  });

  it("lets the worker run ahead when the window is wide — the control", async () => {
    // Same slow consumer, same chunk count, only the window differs. With the
    // default (~1 MiB) these twenty tiny chunks never fill it, so the worker
    // is free to emit them all before the consumer takes the first. That is
    // what makes the previous test's small `maxAhead` mean something: the
    // window is doing the throttling, not the fixture or the transport.
    const dispatcher = dispatcherOverRealWorker();

    let results: { maxAhead: number } | undefined;
    for await (const item of dispatcher.runSubGraphStream!(probeRequest({ count: 20 }))) {
      if (item.kind === "results") {
        results = (item.results[0] as { data: { maxAhead: number } }).data;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(results?.maxAhead).toBeGreaterThan(5);
  });

  it("stops the worker when the consumer breaks early", async () => {
    const dispatcher = dispatcherOverRealWorker(24);

    let seen = 0;
    for await (const item of dispatcher.runSubGraphStream!(probeRequest({ count: 500 }))) {
      if (item.kind === "chunk") {
        seen++;
        if (seen === 2) break;
      }
    }

    // Reaching here without hanging is the assertion: the generator's finally
    // aborts the worker call, so nothing is left producing into a dead channel.
    expect(seen).toBe(2);
  });
});

describe("a crashed worker fails the task", () => {
  it("rejects the in-flight call rather than hanging", async () => {
    const dispatcher = dispatcherOverRealWorker();

    // Before this was wired, a dying thread answered nothing and the caller
    // waited forever — an outcome with no stack, no message and no end. A
    // crash must look like the task throwing, which every caller handles.
    await expect(dispatcher.runSubGraph(probeRequest({ mode: "crash" }))).rejects.toThrow(
      /crashed|died/i
    );
  });

  it("rejects an in-flight streaming call too", async () => {
    const dispatcher = dispatcherOverRealWorker();

    await expect(
      (async () => {
        for await (const _item of dispatcher.runSubGraphStream!(probeRequest({ mode: "crash" }))) {
          // The worker dies before producing anything.
        }
      })()
    ).rejects.toThrow(/crashed|died/i);
  });
});
