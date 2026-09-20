/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives {@link WorkerManager} over a real worker thread, spawned through the
 * `Worker` that `@workglow/util` exports for this runtime.
 *
 * Every other worker suite in the repo substitutes the thread: the idle tests
 * use a `FakeWorker`, and the `WorkerServerBase` tests stub
 * `globalThis.postMessage`. That left the whole `worker_threads` adaptation
 * uncovered, and it was broken in two places that a single real round trip
 * catches:
 *
 * - `worker_threads` rejects a stringified `file://` URL with `ERR_WORKER_PATH`,
 *   and every call site passes `new URL(..., import.meta.url)`, so construction
 *   threw before the worker ever started.
 * - Node's `Worker` is an `EventEmitter`, so a `message` listener receives the
 *   deserialized value, not a `MessageEvent`. `WorkerManager` reads
 *   `event.data`, which was `undefined` — the ready handshake never resolved
 *   and registration timed out after 10s.
 *
 * The same file runs under Bun, which is the point: Bun implements worker
 * threads over the same primitive as its web `Worker`, so one implementation
 * serves both and there is no Bun-specific build to keep in step.
 */

import { Worker, WorkerManager } from "@workglow/util";
import { afterEach, describe, expect, it } from "vitest";

const fixtureUrl = new URL("./workerRoundtrip.fixture.mjs", import.meta.url);

let manager: WorkerManager | undefined;

const registerFixtureWorker = (name: string): WorkerManager => {
  manager = new WorkerManager();
  manager.registerWorker(name, () => new Worker(fixtureUrl, { type: "module" }));
  return manager;
};

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

describe("WorkerManager over a real worker thread", () => {
  it("constructs a worker from a URL", () => {
    // `worker_threads` accepts a URL object and rejects its string form, so
    // this throws ERR_WORKER_PATH the moment the URL is stringified on the way
    // through.
    const worker = new Worker(fixtureUrl, { type: "module" });
    expect(worker).toBeDefined();
    worker.terminate();
  });

  it("completes the ready handshake and calls a function", async () => {
    const workers = registerFixtureWorker("roundtrip");
    const result = await workers.callWorkerFunction<{ args: unknown[] }>("roundtrip", "echo", [
      "a",
      1,
    ]);
    expect(result.args).toEqual(["a", 1]);
  });

  it("advertises its functions, so an unregistered name never leaves the host", async () => {
    const workers = registerFixtureWorker("roundtrip");
    // Resolved from the ready message's `functions` list — proof the handshake
    // payload arrived, not just that some message did.
    await expect(workers.callWorkerFunction("roundtrip", "notAFunction", [])).rejects.toThrow(
      /not registered on worker/
    );
  });

  it("delivers progress before the result", async () => {
    const workers = registerFixtureWorker("roundtrip");
    const seen: Array<{ progress: number; message?: string }> = [];
    const result = await workers.callWorkerFunction<string>("roundtrip", "withProgress", [], {
      onProgress: (progress, message) => seen.push({ progress, message }),
    });
    expect(result).toBe("done");
    expect(seen).toEqual([{ progress: 42, message: "halfway" }]);
  });

  it("carries a TypedArray back across the boundary", async () => {
    const workers = registerFixtureWorker("roundtrip");
    const result = await workers.callWorkerFunction<{ values: Float32Array }>(
      "roundtrip",
      "vector",
      []
    );
    expect(Array.from(result.values)).toEqual([1.5, 2.5, 3.5]);
  });

  it("rehydrates a worker error with its name and message", async () => {
    const workers = registerFixtureWorker("roundtrip");
    await expect(workers.callWorkerFunction("roundtrip", "boom", [])).rejects.toMatchObject({
      name: "RangeError",
      message: "worker exploded",
    });
  });

  it("terminates the thread on dispose", async () => {
    const workers = registerFixtureWorker("roundtrip");
    await workers.callWorkerFunction("roundtrip", "echo", []);
    await workers.terminateWorker("roundtrip");
    await expect(workers.callWorkerFunction("roundtrip", "echo", [])).rejects.toThrow(/not found/);
  });

  it("honours a signal already aborted before the call was made", async () => {
    const workers = registerFixtureWorker("pre-aborted");

    // `callWorkerFunction` awaits worker startup before attaching its abort
    // listener, and `addEventListener` on an already-aborted signal never
    // fires. Without an explicit `.aborted` check the call would be sent and
    // the worker would run it to completion with nothing awaiting the result —
    // the same hazard `TaskRunContext` documents for parent signals.
    await expect(
      workers.callWorkerFunction("pre-aborted", "hang", [], { signal: AbortSignal.abort() })
    ).rejects.toThrow(/abort/i);
  });
});
