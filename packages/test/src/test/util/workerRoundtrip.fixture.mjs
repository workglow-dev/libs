/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker-thread fixture for WorkerManager.roundtrip.test.ts.
 *
 * Speaks the WorkerManager wire protocol by hand rather than importing
 * `@workglow/util/worker`. A thread spawned by `worker_threads` is resolved by
 * the runtime, not by vitest, so a `@workglow/*` specifier here resolves
 * through `exports` to `dist` — which under `use-source` is a stub re-exporting
 * an extensionless `../src/*.ts` path that plain Node cannot resolve. The test
 * would then pass or fail on whether the tree was built or stubbed, rather than
 * on the code under test.
 *
 * It does mirror one thing `Worker.node.ts` relies on: replies go out through
 * `parentPort`, and messages arrive via `parentPort.addEventListener` as a
 * `MessageEvent` with a `.data`. Node worker threads have no global
 * `postMessage` at all, so a fixture written the other way would only ever run
 * under Bun.
 *
 * Plain `.mjs` (not `.ts`) so `worker_threads` can launch it directly under the
 * Node runtime vitest uses, with no TypeScript transform step.
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("workerRoundtrip.fixture.mjs must run as a worker thread");
}

const post = (message, transfer) => parentPort.postMessage(message, transfer);

/**
 * Aborts that arrived before the call they cancel, by request id.
 *
 * `WorkerManager` posts the abort for an already-aborted signal *before* it
 * posts the call, and `WorkerServerBase` parks it (`consumePendingAbort`). A
 * fixture that dropped it would leave `hang` running and report a working
 * path as a timeout.
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
    pendingAborts.add(id);
    return;
  }
  if (type !== "call") return;

  if (pendingAborts.delete(id)) {
    postAborted(id);
    return;
  }

  switch (functionName) {
    case "echo": {
      post({ id, type: "complete", data: { args } });
      return;
    }
    case "vector": {
      // Returned with its buffer in the transfer list, the zero-copy path
      // WorkerServerBase takes for a TypedArray result.
      const values = new Float32Array([1.5, 2.5, 3.5]);
      post({ id, type: "complete", data: { values } }, [values.buffer]);
      return;
    }
    case "withProgress": {
      post({ id, type: "progress", data: { progress: 42, message: "halfway", details: { i: 1 } } });
      post({ id, type: "complete", data: "done" });
      return;
    }
    case "hang": {
      // Never answers on its own: only an abort resolves it.
      return;
    }
    case "boom": {
      post({
        id,
        type: "error",
        data: {
          message: "worker exploded",
          name: "RangeError",
          stack: "RangeError: worker exploded",
        },
      });
      return;
    }
    default: {
      post({
        id,
        type: "error",
        data: { message: `no such function: ${functionName}`, name: "Error" },
      });
    }
  }
});

post({
  type: "ready",
  functions: ["echo", "vector", "withProgress", "boom", "hang"],
  streamFunctions: [],
  previewFunctions: [],
});
