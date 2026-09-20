/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServiceRegistry, WorkerManager } from "@workglow/util";
import { globalServiceRegistry, WORKER_MANAGER, WORKER_SERVER } from "@workglow/util";
import type {
  ISubGraphDispatcher,
  SubGraphRunOptions,
  SubGraphRunRequest,
  SubGraphRunResults,
  SubGraphStreamItem,
} from "./SubGraphDispatch";
import { runSubGraphRequest, runSubGraphStreamRequest } from "./SubGraphDispatch";

/**
 * The worker function name both halves agree on. Not configurable: a worker
 * either speaks this protocol or it is not a subgraph worker.
 */
export const SUBGRAPH_WORKER_FUNCTION = "runSubGraph";

/** The streaming counterpart, registered as a run-function (emit + resolve). */
export const SUBGRAPH_STREAM_WORKER_FUNCTION = "runSubGraphStream";

/**
 * Default credit window, in {@link streamChunkCost} units (~1 MiB of text or
 * binary). Large enough that a well-matched producer and consumer never touch
 * it, small enough that a runaway producer is stopped long before the caller's
 * heap notices.
 */
export const DEFAULT_SUBGRAPH_CREDIT_WINDOW = 1024 * 1024;

/**
 * Runs subgraphs on a worker thread through {@link WorkerManager}.
 *
 * Deliberately thin. The manager already owns everything hard about the
 * boundary — lazy construction, single-flight init, idle eviction, request
 * correlation, progress, abort, and error rehydration with stack scrubbing —
 * so this adds the subgraph *vocabulary* and nothing else. If it grows a
 * retry, a queue, or a pool policy, that belongs in the manager where every
 * other worker caller can have it too.
 *
 * `workerName` must already be registered with the manager. Registration is
 * the application's job, because the worker's entry file is the application's:
 * only it knows which tasks to register and what to bring up first.
 */
export class WorkerSubGraphDispatcher implements ISubGraphDispatcher {
  constructor(
    private readonly workerName: string,
    private readonly registry: ServiceRegistry = globalServiceRegistry,
    private readonly creditWindow: number = DEFAULT_SUBGRAPH_CREDIT_WINDOW
  ) {}

  async runSubGraph(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): Promise<SubGraphRunResults> {
    const manager = this.registry.get(WORKER_MANAGER) as WorkerManager | undefined;
    if (manager === undefined) {
      throw new Error(
        "WorkerSubGraphDispatcher: no WORKER_MANAGER is registered, so no worker can be reached"
      );
    }

    return await manager.callWorkerFunction<SubGraphRunResults>(
      this.workerName,
      SUBGRAPH_WORKER_FUNCTION,
      [request],
      {
        signal: options?.signal,
        onProgress:
          options?.onProgress === undefined
            ? undefined
            : (progress: number, message?: string) => options.onProgress!(progress, message),
      }
    );
  }

  /**
   * Streaming dispatch: yields each chunk as the worker produces it, then one
   * terminal `results` item.
   *
   * The consumer's reads are what pace the worker. Each item is handed over
   * through a one-slot channel whose `push` resolves only once this generator
   * has yielded it, and the manager credits the worker when that promise
   * settles — so a consumer that stops pulling stops the flow rather than
   * silently accumulating a backlog on this side.
   */
  async *runSubGraphStream(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): AsyncIterable<SubGraphStreamItem> {
    const manager = this.registry.get(WORKER_MANAGER) as WorkerManager | undefined;
    if (manager === undefined) {
      throw new Error(
        "WorkerSubGraphDispatcher: no WORKER_MANAGER is registered, so no worker can be reached"
      );
    }

    const channel = new HandoffChannel<SubGraphStreamItem>();

    // Chained to the caller's signal so the run can also be stopped from here.
    // Closing the channel alone does not stop a worker: its pushes simply
    // resolve immediately once closed (a closed channel must never deadlock a
    // producer), so a consumer that breaks early would leave the subgraph
    // running to completion, posting chunks nobody reads.
    const control = new AbortController();
    const abortFromCaller = () => control.abort();
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options?.signal?.aborted === true) control.abort();

    const call = manager
      .callWorkerRunFunction<SubGraphStreamItem>(
        this.workerName,
        SUBGRAPH_STREAM_WORKER_FUNCTION,
        [request],
        {
          signal: control.signal,
          creditWindow: this.creditWindow,
          // Returning the push promise is the whole mechanism: the manager
          // credits the worker only once this settles, which happens when the
          // consumer below pulls the item.
          emit: (item) => channel.push(item),
        }
      )
      .then(
        () => channel.close(),
        (error: unknown) => channel.fail(error)
      );

    try {
      for await (const item of channel) {
        yield item;
      }
    } finally {
      // A consumer that breaks early must not leave the worker producing into
      // a channel nobody reads.
      control.abort();
      channel.close();
      options?.signal?.removeEventListener("abort", abortFromCaller);
      await call.catch(() => {});
    }
  }
}

/**
 * A one-slot async handoff.
 *
 * `push` resolves when the value is taken, not when it is stored, which is
 * what lets a producer be paced by a consumer across an await. Deliberately
 * not a queue: a queue would buffer, and buffering silently is exactly the
 * behaviour the credit window exists to prevent.
 */
class HandoffChannel<T> implements AsyncIterable<T> {
  private slot: { value: T; taken: () => void } | undefined;
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private pushWaiter: (() => void) | undefined;
  private closed = false;
  private failure: unknown;

  push(value: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const deliver = () => {
        const waiting = this.waiting;
        if (waiting !== undefined) {
          this.waiting = undefined;
          resolve();
          waiting({ value, done: false });
          return;
        }
        this.slot = { value, taken: resolve };
      };
      // One slot: a second push waits for the first to be taken.
      if (this.slot === undefined) deliver();
      else this.pushWaiter = deliver;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.({ value: undefined as never, done: true });
    this.waiting = undefined;
    this.slot?.taken();
    this.slot = undefined;
    this.pushWaiter?.();
    this.pushWaiter = undefined;
  }

  fail(error: unknown): void {
    this.failure = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.slot !== undefined) {
        const { value, taken } = this.slot;
        this.slot = undefined;
        const nextPush = this.pushWaiter;
        this.pushWaiter = undefined;
        taken();
        nextPush?.();
        yield value;
        continue;
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done === true) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}

/**
 * Registers the subgraph handler on this worker's `WorkerServer`.
 *
 * Call this from the application's worker entry **after** it has brought up
 * whatever the tasks need — database, credentials, models — and registered its
 * task constructors, since {@link runSubGraphRequest} resolves every task type
 * through `registry` at the moment a request arrives.
 *
 * The `registry` passed here is the worker's own, and is expected to bind a
 * fuller `TASK_CONSTRUCTORS` map than the host process exposes on its CLI:
 * "types this thread can rebuild" and "tasks a human may invoke by name" are
 * different questions, and this is the side that answers the first one.
 *
 * `postProgress` arrives third by the `WorkerServer` calling convention
 * (`fn(input, model, postProgress, signal)`); `model` is unused here because a
 * subgraph names whatever models it needs from inside.
 */
export function registerSubGraphWorker(registry?: ServiceRegistry): void {
  const server = (registry ?? globalServiceRegistry).get(WORKER_SERVER);
  if (server === undefined) {
    throw new Error(
      "registerSubGraphWorker: no WORKER_SERVER is registered — this is not a worker thread"
    );
  }

  server.registerRunFunction(
    SUBGRAPH_STREAM_WORKER_FUNCTION,
    async (
      request: unknown,
      _model: unknown,
      signal: AbortSignal,
      emit: (event: unknown) => void | Promise<void>
    ): Promise<void> =>
      await runSubGraphStreamRequest(
        request as SubGraphRunRequest,
        registry,
        (item) => emit(item),
        {
          signal,
        }
      )
  );

  server.registerFunction(
    SUBGRAPH_WORKER_FUNCTION,
    async (
      request: SubGraphRunRequest,
      _model: unknown,
      postProgress: (progress: number, message?: string) => void,
      signal: AbortSignal
    ): Promise<SubGraphRunResults> =>
      await runSubGraphRequest(request, registry, {
        signal,
        // The manager's progress channel carries a number; an indeterminate
        // tick from inside the subgraph has nothing meaningful to send, so it
        // is dropped here rather than turned into a fake percentage.
        onProgress: (progress, message) => {
          if (progress !== undefined) postProgress(progress, message);
        },
      })
  );
}
