/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken, globalServiceRegistry } from "../di";
import { getLogger } from "../logging";
import { rehydrateWorkerError } from "./scrubStack";
import { streamChunkCost } from "./streamCost";

export class WorkerManager {
  private workers: Map<string, Worker> = new Map();
  private readyWorkers: Map<string, Promise<void>> = new Map();
  /** Function names registered on each worker, populated from the ready message. */
  private workerFunctions: Map<string, Set<string>> = new Map();
  private workerStreamFunctions: Map<string, Set<string>> = new Map();
  private workerPreviewFunctions: Map<string, Set<string>> = new Map();
  /** Persistent factories for workers that can be recreated after termination. */
  private workerFactories: Map<string, () => Worker> = new Map();
  /** Idle timeout configuration per registered worker. */
  private idleTimeouts: Map<string, number> = new Map();
  /** Single-flight init promise per name (lazy path). */
  private lazyInitPromises: Map<string, Promise<void>> = new Map();
  /** In-flight call count per worker name. */
  private activeCallCounts: Map<string, number> = new Map();
  /** Scheduled idle termination timer per worker name. */
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** In-flight termination promise per worker name. */
  private terminationPromises: Map<string, Promise<void>> = new Map();

  registerWorker(
    name: string,
    workerOrFactory: Worker | (() => Worker),
    options?: { idleTimeoutMs?: number }
  ): void {
    if (this.workers.has(name)) {
      throw new Error(`Worker ${name} is already registered.`);
    }
    if (this.workerFactories.has(name)) {
      throw new Error(`Worker ${name} is already registered.`);
    }
    this.idleTimeouts.set(name, options?.idleTimeoutMs ?? 0);
    if (typeof workerOrFactory === "function") {
      this.workerFactories.set(name, workerOrFactory);
    } else {
      this.attachWorkerInstance(name, workerOrFactory);
    }
  }

  private attachWorkerInstance(name: string, worker: Worker): void {
    this.clearIdleTimer(name);
    this.workers.set(name, worker);
    worker.addEventListener("error", (event) => {
      // `filename`/`lineno` come from the browser's `ErrorEvent`; a
      // `worker_threads` error carries neither, so they are reported only when
      // the platform actually supplied them rather than as "at undefined".
      const location =
        event.filename !== undefined ? ` at ${event.filename} line: ${event.lineno}` : "";
      console.error(`Worker Error: ${event.message ?? "unknown error"}${location}`);
    });
    worker.addEventListener("messageerror", (event) => {
      console.error("Worker message error:", event);
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener("message", handleReady);
        worker.removeEventListener("error", handleError);
        reject(new Error(`Worker "${name}" did not become ready within 10s`));
      }, 10_000);

      const handleError = (event: ErrorEvent) => {
        clearTimeout(timeout);
        worker.removeEventListener("message", handleReady);
        worker.removeEventListener("error", handleError);
        reject(
          new Error(`Worker "${name}" initialization error: ${event.message ?? "unknown error"}`)
        );
      };

      const handleReady = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          clearTimeout(timeout);
          worker.removeEventListener("message", handleReady);
          worker.removeEventListener("error", handleError);
          this.workerFunctions.set(name, new Set(event.data.functions ?? []));
          this.workerStreamFunctions.set(name, new Set(event.data.streamFunctions ?? []));
          this.workerPreviewFunctions.set(name, new Set(event.data.previewFunctions ?? []));
          resolve();
        }
      };

      worker.addEventListener("message", handleReady);
      worker.addEventListener("error", handleError);
    });

    this.readyWorkers.set(name, readyPromise);
  }

  /**
   * Ensures a lazy worker is constructed and ready. No-op if already
   * registered eagerly.
   */
  private async ensureWorkerReady(name: string): Promise<void> {
    await this.terminationPromises.get(name);

    if (this.workers.has(name)) {
      await this.readyWorkers.get(name)!;
      return;
    }
    const factory = this.workerFactories.get(name);
    if (!factory) {
      throw new Error(`Worker ${name} not found.`);
    }
    let init = this.lazyInitPromises.get(name);
    if (!init) {
      init = (async () => {
        let worker: Worker | undefined;
        try {
          const f = this.workerFactories.get(name)!;
          worker = f();
          this.attachWorkerInstance(name, worker);
          await this.readyWorkers.get(name)!;
        } catch (error) {
          await this.cleanupFailedInitialization(name, worker);
          throw error;
        } finally {
          this.lazyInitPromises.delete(name);
        }
      })();
      this.lazyInitPromises.set(name, init);
    }
    await init;
  }

  getWorker(name: string): Worker {
    const worker = this.workers.get(name);
    if (!worker) throw new Error(`Worker ${name} not found.`);
    return worker;
  }

  private beginWorkerActivity(name: string): void {
    this.clearIdleTimer(name);
    this.activeCallCounts.set(name, (this.activeCallCounts.get(name) ?? 0) + 1);
  }

  private endWorkerActivity(name: string): void {
    const nextCount = (this.activeCallCounts.get(name) ?? 0) - 1;
    if (nextCount > 0) {
      this.activeCallCounts.set(name, nextCount);
      return;
    }
    this.activeCallCounts.delete(name);
    this.scheduleIdleTermination(name);
  }

  private clearIdleTimer(name: string): void {
    const timer = this.idleTimers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(name);
    }
  }

  private scheduleIdleTermination(name: string): void {
    this.clearIdleTimer(name);

    const idleTimeoutMs = this.idleTimeouts.get(name) ?? 0;
    if (idleTimeoutMs <= 0 || !this.workerFactories.has(name) || !this.workers.has(name)) {
      return;
    }

    const timer = setTimeout(() => {
      this.idleTimers.delete(name);
      if ((this.activeCallCounts.get(name) ?? 0) > 0 || !this.workers.has(name)) {
        return;
      }
      void this.terminateWorkerInstance(name).catch((error) => {
        getLogger().warn(`Worker ${name} idle termination failed.`, { error });
      });
    }, idleTimeoutMs);

    this.idleTimers.set(name, timer);
  }

  private async cleanupFailedInitialization(
    name: string,
    worker: Worker | undefined
  ): Promise<void> {
    this.clearIdleTimer(name);
    if (worker !== undefined && this.workers.get(name) === worker) {
      this.workers.delete(name);
    }
    this.readyWorkers.delete(name);
    this.workerFunctions.delete(name);
    this.workerStreamFunctions.delete(name);
    this.workerPreviewFunctions.delete(name);
    this.activeCallCounts.delete(name);
    if (worker && "terminate" in worker && typeof worker.terminate === "function") {
      try {
        // The DOM `Worker` is what this file's `Worker` type resolves to, and
        // its `terminate()` returns `void` — but under Node the instance is a
        // `worker_threads.Worker`, whose `terminate()` returns a promise that
        // settles when the thread is gone. Dropping the await would let this
        // resolve while the thread is still running.
        // oxlint-disable-next-line typescript/await-thenable
        await worker.terminate();
      } catch {
        // Best-effort cleanup after failed startup.
      }
    }
  }

  private async terminateWorkerInstance(name: string): Promise<void> {
    const existing = this.terminationPromises.get(name);
    if (existing) {
      await existing;
      return;
    }

    const termination = (async () => {
      this.clearIdleTimer(name);
      const worker = this.workers.get(name);
      this.workers.delete(name);
      this.readyWorkers.delete(name);
      this.workerFunctions.delete(name);
      this.workerStreamFunctions.delete(name);
      this.workerPreviewFunctions.delete(name);
      this.activeCallCounts.delete(name);
      try {
        if (worker && "terminate" in worker && typeof worker.terminate === "function") {
          // As above: `void` by the DOM type, a promise under Node.
          // oxlint-disable-next-line typescript/await-thenable
          await worker.terminate();
        }
      } catch {
        // Best-effort termination; runtime state is already cleaned up above.
      }
    })();

    this.terminationPromises.set(name, termination);
    try {
      await termination;
    } finally {
      this.terminationPromises.delete(name);
    }
  }

  /**
   * Turns a worker crash into a rejection for one in-flight request.
   *
   * A thread that dies — an uncaught throw, a failed start — emits `error` and
   * then answers nothing. Without this the request's promise is never settled
   * and the caller waits forever, which is the one outcome worse than failing:
   * a hang has no stack, no message, and no end. Rejecting instead makes a
   * crashed worker behave exactly like the task throwing, which is what every
   * caller already knows how to handle.
   *
   * Returns a detach to call from the request's own cleanup, so a long-lived
   * worker does not accumulate one listener per call.
   */
  private onWorkerCrash(
    worker: Worker,
    workerName: string,
    functionName: string,
    reject: (error: Error) => void
  ): () => void {
    const handleCrash = (event: { message?: string; error?: unknown }) => {
      const detail =
        event?.message ?? (event?.error as Error | undefined)?.message ?? "unknown error";
      reject(new Error(`Worker "${workerName}" crashed during "${functionName}": ${detail}`));
    };
    worker.addEventListener("error", handleCrash as (event: any) => void);
    return () => worker.removeEventListener("error", handleCrash as (event: any) => void);
  }

  async callWorkerFunction<T>(
    workerName: string,
    functionName: string,
    args: any[],
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: number, message?: string, details?: any) => void;
    }
  ): Promise<T> {
    await this.ensureWorkerReady(workerName);
    const worker = this.workers.get(workerName);
    if (!worker) throw new Error(`Worker ${workerName} not found.`);
    this.beginWorkerActivity(workerName);

    try {
      const knownFunctions = this.workerFunctions.get(workerName);
      if (knownFunctions && !knownFunctions.has(functionName)) {
        throw new Error(`Function "${functionName}" is not registered on worker "${workerName}".`);
      }

      return await new Promise<T>((resolve, reject) => {
        const requestId = crypto.randomUUID();

        const handleMessage = (event: MessageEvent) => {
          const { id, type, data } = event.data;
          if (id !== requestId) return;
          if (type === "progress" && options?.onProgress) {
            options.onProgress(data.progress, data.message, data.details);
            getLogger().debug(
              `Worker ${workerName} function ${functionName} progress: ${data.progress}, `,
              { data }
            );
          } else if (type === "complete") {
            cleanup();
            getLogger().debug(`Worker ${workerName} function ${functionName} complete.`, { data });
            resolve(data);
          } else if (type === "error") {
            cleanup();
            // Log the rehydrated error, not the raw payload — a third-party
            // worker's `data.stack` may carry the absolute paths scrubbing
            // exists to remove.
            const error = rehydrateWorkerError(data);
            getLogger().debug(`Worker ${workerName} function ${functionName} error.`, { error });
            reject(error);
          }
        };

        const handleAbort = () => {
          worker.postMessage({ id: requestId, type: "abort" });
          getLogger().info(`Worker ${workerName} function ${functionName} aborted.`);
        };

        const detachCrash = this.onWorkerCrash(worker, workerName, functionName, reject);

        const cleanup = () => {
          worker.removeEventListener("message", handleMessage);
          options?.signal?.removeEventListener("abort", handleAbort);
          detachCrash();
        };

        worker.addEventListener("message", handleMessage);

        if (options?.signal) {
          // Listen first, then check: `addEventListener` on an already-aborted
          // signal never fires. The window is real rather than theoretical —
          // `ensureWorkerReady` above may have just spawned a thread and waited
          // on its handshake, so a caller that aborted during startup would
          // otherwise have its work run to completion in the worker, holding a
          // slot and producing a result nothing is waiting for.
          //
          // Posting the abort before the `call` below is safe by design:
          // `WorkerServerBase` parks an abort that beats its call and consumes
          // it when the call lands (`consumePendingAbort`).
          options.signal.addEventListener("abort", handleAbort, { once: true });
          if (options.signal.aborted) handleAbort();
        }

        // Note: We intentionally do NOT transfer TypedArrays from the main thread to the worker.
        // Transferring detaches the buffers on the main thread, which breaks downstream tasks
        // that still need those TypedArrays (e.g., the embedding vectors flowing through the
        // task graph). Workers send results back with transferables (zero-copy), but the
        // main thread always clones data going to workers to preserve its own references.
        const message = { id: requestId, type: "call", functionName, args };
        worker.postMessage(message);
        getLogger().info(`Worker ${workerName} function ${functionName} called.`);
      });
    } finally {
      this.endWorkerActivity(workerName);
    }
  }

  /**
   * Call a preview function on a worker. Returns undefined (rather than throwing)
   * if the worker has no preview function registered for the given name, so callers
   * can treat the result as an optional preview.
   *
   * @param workerName - Registered worker name
   * @param functionName - Name of the preview function registered on the worker
   * @param args - Arguments to pass: [input, output, model]
   * @returns The preview result, or undefined if not registered / on error
   */
  async callWorkerPreviewFunction<T>(
    workerName: string,
    functionName: string,
    args: any[]
  ): Promise<T | undefined> {
    await this.ensureWorkerReady(workerName);
    const worker = this.workers.get(workerName);
    if (!worker) return undefined;
    this.beginWorkerActivity(workerName);

    try {
      // Skip the roundtrip if the worker didn't register a preview function for this name.
      const knownPreview = this.workerPreviewFunctions.get(workerName);
      if (knownPreview && !knownPreview.has(functionName)) return undefined;

      return await new Promise((resolve) => {
        const requestId = crypto.randomUUID();

        const handleMessage = (event: MessageEvent) => {
          const { id, type, data } = event.data;
          if (id !== requestId) return;
          if (type === "complete") {
            cleanup();
            resolve(data as T | undefined);
          } else if (type === "error") {
            cleanup();
            getLogger().warn(`Worker ${workerName} preview function ${functionName} error:`, {
              error: rehydrateWorkerError(data),
            });
            resolve(undefined);
          }
        };

        const cleanup = () => {
          worker.removeEventListener("message", handleMessage);
        };

        worker.addEventListener("message", handleMessage);

        const message = { id: requestId, type: "call", functionName, args, preview: true };
        // Note: No transferables — same reasoning as callWorkerFunction above.
        worker.postMessage(message);
        getLogger().info(`Worker ${workerName} preview function ${functionName} called.`);
      });
    } finally {
      this.endWorkerActivity(workerName);
    }
  }

  /**
   * Terminate a single worker and clean up all associated state.
   */
  async terminateWorker(name: string): Promise<void> {
    await this.terminateWorkerInstance(name);
    this.workerFactories.delete(name);
    this.idleTimeouts.delete(name);
    this.lazyInitPromises.delete(name);
  }

  /**
   * Terminate all workers and release resources.
   */
  async dispose(): Promise<void> {
    const names = [...new Set([...this.workers.keys(), ...this.workerFactories.keys()])];
    for (const name of names) {
      await this.terminateWorker(name);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Call a streaming function on a worker and return an AsyncGenerator that
   * yields each stream chunk sent by the worker. The worker sends `stream_chunk`
   * messages for each yielded event and a `complete` message when the generator
   * finishes. An `error` message from the worker causes the iterator to throw.
   *
   * @param workerName - Registered worker name
   * @param functionName - Name of the stream function registered on the worker
   * @param args - Arguments to pass to the stream function
   * @param options - Optional abort signal
   * @returns AsyncGenerator yielding stream events from the worker
   */
  async *callWorkerStreamFunction<T>(
    workerName: string,
    functionName: string,
    args: any[],
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<T> {
    await this.ensureWorkerReady(workerName);
    const worker = this.workers.get(workerName);
    if (!worker) throw new Error(`Worker ${workerName} not found.`);
    this.beginWorkerActivity(workerName);

    try {
      // The worker falls back to regular functions for stream calls, so either counts.
      const knownStream = this.workerStreamFunctions.get(workerName);
      const knownFns = this.workerFunctions.get(workerName);
      if (
        knownStream &&
        knownFns &&
        !knownStream.has(functionName) &&
        !knownFns.has(functionName)
      ) {
        throw new Error(`Function "${functionName}" is not registered on worker "${workerName}".`);
      }

      const requestId = crypto.randomUUID();

      // Push-queue pattern: messages push items, async generator pulls them
      type QueueItem =
        | { kind: "event"; data: T }
        | { kind: "done" }
        | { kind: "error"; error: Error };

      const queue: QueueItem[] = [];
      let waiting: ((value: void) => void) | null = null;

      const notify = () => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve();
        }
      };

      const handleMessage = (event: MessageEvent) => {
        const { id, type, data } = event.data;
        if (id !== requestId) return;

        if (type === "stream_chunk") {
          queue.push({ kind: "event", data });
          notify();
        } else if (type === "complete") {
          queue.push({ kind: "done" });
          notify();
        } else if (type === "error") {
          queue.push({ kind: "error", error: rehydrateWorkerError(data) });
          notify();
        }
      };

      const handleAbort = () => {
        worker.postMessage({ id: requestId, type: "abort" });
        getLogger().info(`Worker ${workerName} stream function ${functionName} aborted.`);
      };

      const detachCrash = this.onWorkerCrash(worker, workerName, functionName, (error) => {
        queue.push({ kind: "error", error });
        notify();
      });

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        options?.signal?.removeEventListener("abort", handleAbort);
        detachCrash();
      };

      worker.addEventListener("message", handleMessage);

      if (options?.signal) {
        if (options.signal.aborted) {
          cleanup();
          throw new Error("Operation aborted");
        }
        options.signal.addEventListener("abort", handleAbort, { once: true });
      }

      // Send call message with stream flag
      // Note: No transferables — same reasoning as callWorkerFunction above.
      const message = { id: requestId, type: "call", functionName, args, stream: true };
      worker.postMessage(message);
      getLogger().info(`Worker ${workerName} stream function ${functionName} called.`);

      let completedNormally = false;
      try {
        while (true) {
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.kind === "event") {
              yield item.data;
            } else if (item.kind === "done") {
              completedNormally = true;
              return;
            } else if (item.kind === "error") {
              completedNormally = true;
              throw item.error;
            }
          }

          // Wait for the next message to arrive
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
        }
      } finally {
        // If the consumer stopped iterating early (break/return), notify
        // the worker to abort so it doesn't continue generating tokens.
        if (!completedNormally) {
          worker.postMessage({ id: requestId, type: "abort" });
          getLogger().info(`Worker ${workerName} stream function ${functionName} aborted.`);
        }
        cleanup();
      }
    } finally {
      this.endWorkerActivity(workerName);
    }
  }

  /**
   * Calls a new-shape run function on a registered worker. Returns
   * `Promise<void>`; the run-fn's emitted events arrive via the caller-supplied
   * `emit` callback (passed via `options.emit`). The Promise resolves on the
   * worker's terminal `result` message and rejects on `error`.
   *
   * Wire protocol: same `stream_chunk` messages as {@link callWorkerStreamFunction}
   * for events; the terminal `complete` message carries `data: undefined` and
   * signals completion. `postMessage` ordering on the same port guarantees all
   * `stream_chunk` messages arrive before the terminal `complete`, so the local
   * message handler drains them before resolving.
   */
  async callWorkerRunFunction<T>(
    workerName: string,
    functionName: string,
    args: unknown[],
    options: {
      signal?: AbortSignal;
      /**
       * Consumes one event. Returning a promise opts into pacing: with a
       * `creditWindow` open, the worker is not credited for the event until
       * that promise settles, so a slow consumer throttles the producer
       * instead of accumulating its backlog here.
       */
      emit: (event: T) => void | Promise<void>;
      /**
       * Bound, in cost units, on how much emitted-but-unconsumed payload the
       * worker may have in flight. Omit for the unbounded behaviour a caller
       * that does not pace itself still gets.
       *
       * Cost is `streamChunkCost`: bytes for binary, characters for text, one
       * per item otherwise.
       */
      creditWindow?: number;
    }
  ): Promise<void> {
    await this.ensureWorkerReady(workerName);
    const worker = this.workers.get(workerName);
    if (!worker) throw new Error(`Worker ${workerName} not found.`);
    this.beginWorkerActivity(workerName);

    try {
      const requestId = crypto.randomUUID();
      let resolveFn: () => void;
      let rejectFn: (e: unknown) => void;
      const completion = new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });

      const handleMessage = (event: MessageEvent) => {
        const { id, type, data } = event.data;
        if (id !== requestId) return;
        if (type === "stream_chunk") {
          const consumed = options.emit(data as T);
          if (options.creditWindow !== undefined) {
            // Credit once the consumer has actually taken the event. Credits
            // are plain numbers, so settling out of order across concurrent
            // emits is harmless — only the total matters to the window.
            const cost = streamChunkCost(data);
            const release = () => {
              try {
                worker.postMessage({ id: requestId, type: "stream_credit", cost });
              } catch {
                // The worker is gone; its gate went with it.
              }
            };
            // Credited even when the consumer throws: a refusal to consume
            // must not strand the producer parked on a window that can never
            // reopen. The throw still surfaces through the consumer's own path.
            void Promise.resolve(consumed).then(release, release);
          }
        } else if (type === "complete") {
          // `complete` carries undefined data — the protocol mirrors the stream
          // path's terminal message, with `data: undefined` indicating completion.
          resolveFn();
        } else if (type === "error") {
          rejectFn(rehydrateWorkerError(data));
        }
      };

      const handleAbort = () => {
        worker.postMessage({ id: requestId, type: "abort" });
      };

      const detachCrash = this.onWorkerCrash(worker, workerName, functionName, (error) =>
        rejectFn(error)
      );

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        options.signal?.removeEventListener("abort", handleAbort);
        detachCrash();
      };

      worker.addEventListener("message", handleMessage);
      if (options.signal) {
        if (options.signal.aborted) {
          cleanup();
          throw new Error("Operation aborted");
        }
        options.signal.addEventListener("abort", handleAbort, { once: true });
      }

      worker.postMessage({
        id: requestId,
        type: "call",
        functionName,
        args,
        run: true,
        creditWindow: options.creditWindow,
      });

      try {
        await completion;
      } finally {
        cleanup();
      }
    } finally {
      this.endWorkerActivity(workerName);
    }
  }
}

export const WORKER_MANAGER = createServiceToken<WorkerManager>("worker.manager");

/**
 * Registers the WorkerManager default factory on the given registry.
 * Called by `bootstrapWorkglow` and `createOrchestrationContext`.
 */
export function registerWorkerManagerDefaults(
  registry: import("../di/ServiceRegistry").ServiceRegistry = globalServiceRegistry
): void {
  registry.registerIfAbsent(WORKER_MANAGER, () => new WorkerManager(), true);
}

// Self-register on the global registry. Idempotent.
registerWorkerManagerDefaults();
