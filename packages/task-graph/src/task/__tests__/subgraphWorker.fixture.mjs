/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker-thread fixture for WorkerSubGraphDispatcher.integration.test.ts.
 *
 * Speaks the WorkerManager wire protocol by hand rather than importing
 * `@workglow/task-graph`, for the reason `workerRoundtrip.fixture.mjs`
 * documents: a thread spawned by `worker_threads` resolves specifiers through
 * the runtime, not vitest, so a `@workglow/*` import here resolves via
 * `exports` to `dist` — which under `use-source` is a stub re-exporting an
 * extensionless `../src/*.ts` path plain Node cannot load. The test would then
 * be measuring whether the tree was built.
 *
 * So this fixture does NOT run a real subgraph. It is the far end of the
 * *wire*, and what it exists to prove is everything the dispatcher is
 * responsible for: that the request arrives structured-cloneable and intact,
 * that progress flows back, that an abort reaches the worker, and that a
 * remote throw rehydrates on the caller. Rebuilding and running a graph is
 * covered in-process by the `runSubGraphRequest` tests, where no thread is
 * needed to exercise it honestly.
 *
 * Behaviour is selected by `request.input.mode`, because the function name is
 * fixed by the protocol (`SUBGRAPH_WORKER_FUNCTION`).
 *
 * Plain `.mjs` so `worker_threads` can launch it under the Node runtime vitest
 * uses, with no TypeScript transform step.
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("subgraphWorker.fixture.mjs must run as a worker thread");
}

const post = (message, transfer) => parentPort.postMessage(message, transfer);

/** Requests parked waiting for an abort, by request id. */
const pending = new Map();

/**
 * Credit gates, by request id — a hand-rolled mirror of the one
 * `WorkerServerBase` keeps, for the same reason the rest of this file is
 * hand-rolled: the worker cannot import `@workglow/*`.
 */
const gates = new Map();

/** Cost of one emitted item, matching `streamChunkCost` closely enough to pace. */
const costOf = (value) => {
  if (value === null || value === undefined) return 1;
  if (typeof value === "string") return Math.max(1, value.length);
  if (ArrayBuffer.isView(value)) return Math.max(1, value.byteLength);
  if (Array.isArray(value)) return Math.max(1, value.reduce((n, v) => n + costOf(v), 0));
  if (typeof value === "object") {
    return Math.max(1, Object.values(value).reduce((n, v) => n + costOf(v), 0));
  }
  return 1;
};

/**
 * Emits `count` chunk items then a terminal `results` item, parking whenever
 * the credit window is full.
 *
 * The results payload reports `maxAhead` — the high-water mark of items
 * emitted but not yet credited. That number is the observable proof that the
 * consumer paced the producer: unbounded forwarding would drive it to `count`.
 */
async function handleStreamRun(id, request, creditWindow) {
  if (request?.input?.mode === "crash") {
    // Same genuine thread death as the plain path: escapes the handler, so the
    // runtime raises `error` and the thread ends mid-request.
    setTimeout(() => {
      throw new Error("worker thread died");
    }, 0);
    return;
  }
  const count = request?.input?.count ?? 3;
  const gate =
    typeof creditWindow === "number" && creditWindow > 0
      ? { window: creditWindow, outstanding: 0, wake: undefined, maxAhead: 0, inFlight: 0 }
      : undefined;
  if (gate !== undefined) gates.set(id, gate);

  const emit = async (item) => {
    post({ id, type: "stream_chunk", data: item });
    if (gate === undefined) return;
    gate.outstanding += costOf(item);
    gate.inFlight += 1;
    gate.maxAhead = Math.max(gate.maxAhead, gate.inFlight);
    if (gate.outstanding >= gate.window) {
      await new Promise((resolve) => {
        gate.wake = () => {
          gate.inFlight = 0;
          resolve();
        };
      });
    }
  };

  try {
    for (let i = 0; i < count; i++) {
      await emit({
        kind: "chunk",
        chunk: { taskId: "worker-task", event: { type: "text-delta", port: "text", textDelta: `${i}` } },
      });
    }
    await emit({
      kind: "results",
      results: [
        { id: "worker-leaf", type: "FixtureLeaf", data: { maxAhead: gate?.maxAhead ?? -1, count } },
      ],
    });
    post({ id, type: "complete", data: undefined });
  } catch (error) {
    post({ id, type: "error", data: { message: String(error), name: "Error" } });
  } finally {
    gates.delete(id);
  }
}

/**
 * Aborts that arrived before the call they cancel, by request id.
 *
 * Mirrors `WorkerServerBase.consumePendingAbort`. The manager posts an abort
 * for an already-aborted signal *before* it posts the call, so a fixture that
 * dropped an abort for an unknown id would park forever and misreport a
 * working path as a hang.
 */
const pendingAborts = new Set();

const postAborted = (id) =>
  post({
    id,
    type: "error",
    data: { message: "aborted by caller", name: "AbortError", stack: "AbortError: aborted" },
  });

parentPort.addEventListener("message", (event) => {
  const { id, type, functionName, args } = event.data;

  if (type === "abort") {
    const parked = pending.get(id);
    if (parked !== undefined) {
      clearTimeout(parked);
      pending.delete(id);
      postAborted(id);
    } else {
      // The abort beat its call; hold it until the call lands.
      pendingAborts.add(id);
    }
    return;
  }

  if (type === "stream_credit") {
    const gate = gates.get(id);
    if (gate !== undefined) {
      gate.outstanding -= typeof event.data.cost === "number" ? event.data.cost : 1;
      if (gate.outstanding < gate.window && gate.wake !== undefined) {
        const wake = gate.wake;
        gate.wake = undefined;
        wake();
      }
    }
    return;
  }

  if (type !== "call") return;

  if (event.data.run === true && functionName === "runSubGraphStream") {
    void handleStreamRun(id, args[0], event.data.creditWindow);
    return;
  }

  if (functionName !== "runSubGraph") {
    post({ id, type: "error", data: { message: `no such function: ${functionName}`, name: "Error" } });
    return;
  }

  if (pendingAborts.delete(id)) {
    postAborted(id);
    return;
  }

  const request = args[0];
  const mode = request?.input?.mode;

  if (mode === "crash") {
    // A genuine thread death, not a protocol error message: throwing from a
    // timer escapes the message handler, so the runtime raises `error` on the
    // worker and the thread ends without answering this request.
    setTimeout(() => {
      throw new Error("worker thread died");
    }, 0);
    return;
  }

  if (mode === "boom") {
    post({
      id,
      type: "error",
      data: {
        message: "subgraph exploded in the worker",
        name: "RangeError",
        stack: "RangeError: subgraph exploded in the worker",
      },
    });
    return;
  }

  if (mode === "hang") {
    // Announce arrival before parking. The caller aborts on this tick rather
    // than on a timer, which is what makes the abort test deterministic: the
    // manager attaches its abort listener only after the worker is ready, so a
    // test that aborted earlier would race that window instead of proving
    // anything about it.
    post({ id, type: "progress", data: { progress: 1, message: "parked" } });
    pending.set(id, setTimeout(() => {}, 60_000));
    return;
  }

  post({ id, type: "progress", data: { progress: 50, message: "halfway through the subgraph" } });

  // Echoes what crossed, so the test can assert the request survived intact
  // rather than merely that something came back.
  post({
    id,
    type: "complete",
    data: [
      {
        id: "fixture-leaf",
        type: "FixtureLeaf",
        data: {
          taskCount: request?.graph?.tasks?.length ?? -1,
          taskTypes: (request?.graph?.tasks ?? []).map((t) => t.type),
          dataflowCount: request?.graph?.dataflows?.length ?? -1,
          echoedInput: request?.input ?? null,
        },
      },
    ],
  });
});

post({
  type: "ready",
  functions: ["runSubGraph", "runSubGraphStream"],
  streamFunctions: [],
  previewFunctions: [],
});
