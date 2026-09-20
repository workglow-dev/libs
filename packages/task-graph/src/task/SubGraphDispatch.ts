/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServiceRegistry } from "@workglow/util";
import { createServiceToken } from "@workglow/util";
import { streamChunkCost } from "@workglow/util";
import type { GraphResultArray } from "../task-graph/TaskGraphRunner";
import { createGraphFromGraphJSON } from "./TaskJSON";
import type { TaskGraphJson } from "./TaskJSON";
import type { StreamEvent } from "./StreamTypes";
import type { TaskInput, TaskOutput } from "./TaskTypes";

/**
 * One subgraph run, described entirely as data.
 *
 * This is the whole contract between a graph and whatever executes part of it
 * elsewhere — another thread today, plausibly another process or host later.
 * Nothing here is a live object, which is the point: a dispatcher may only be
 * handed things that survive `structuredClone`.
 */
export interface SubGraphRunRequest {
  /** The subgraph to run, as {@link TaskGraph.toJSON} produced it. */
  readonly graph: TaskGraphJson;
  /** The run input for this one iteration. */
  readonly input: TaskInput;
  /**
   * The run config that can cross as data.
   *
   * The inline path threads a whole `IRunConfig` into a subgraph run, and most
   * of it is live objects that cannot cross — the output cache is a repository
   * over a live connection, the resource scope is a per-thread disposer list,
   * the usage sinks are callbacks. Those are supplied (or not) by the
   * receiving side; see {@link runSubGraphRequest}.
   *
   * What is left is plain data, and it must cross or a subgraph would run
   * under different semantics purely because it ran elsewhere — silently
   * unenforced entitlements, or a streaming edge that accumulates on one
   * thread and passes through on another.
   */
  readonly runOptions?: SubGraphRunOptionsData;
}

/** The serializable slice of a subgraph's run config. */
export interface SubGraphRunOptionsData {
  readonly enforceEntitlements?: boolean | undefined;
  readonly noAccumulation?: boolean | undefined;
  readonly streamHighWaterBytes?: number | undefined;
  readonly streamGateWatchdogMs?: number | undefined;
}

/**
 * What a dispatcher hands back: the per-leaf results, exactly as
 * {@link TaskGraph.run} returns them — one `{ id, type, data }` entry per leaf
 * task, where `data` is that task's output.
 *
 * Deliberately **not** a merged output. Merging is
 * `mergeExecuteOutputsToRunOutput(results, compoundMerge)`, and
 * `compoundMerge` is a static on the parent task's class — sending it across
 * would mean serializing a merge strategy and trusting the far side to apply
 * the same one. The parent already knows its own strategy, so the far side
 * returns raw results and the parent merges them exactly as it does for an
 * in-process iteration. One merge implementation, one place.
 */
export type SubGraphRunResults = GraphResultArray<TaskOutput>;

export interface SubGraphRunOptions {
  /**
   * Ceiling on forwarded-but-unconsumed cost; see
   * {@link DEFAULT_FORWARD_BUFFER_LIMIT}.
   */
  readonly forwardBufferLimit?: number | undefined;
  /**
   * Cancels the remote run. A dispatcher must forward this — an iteration left
   * running after its parent aborted holds a worker slot and writes rows
   * nothing is waiting for.
   */
  readonly signal?: AbortSignal | undefined;
  /** Progress from the remote run, for the parent's own progress aggregation. */
  readonly onProgress?: ((progress: number | undefined, message?: string) => void) | undefined;
}

/**
 * Runs a subgraph somewhere other than here.
 *
 * Implementations are free about *where*; the only contract is this signature
 * plus the serializability {@link SubGraphRunRequest} implies. A worker-backed
 * implementation is the reason this exists, but a test double is an equally
 * valid one, and that is what keeps the runner's threaded path testable
 * without spawning anything.
 */
export interface ISubGraphDispatcher {
  runSubGraph(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): Promise<SubGraphRunResults>;

  /**
   * Runs a subgraph, yielding chunks as they are produced and one terminal
   * `results` item.
   *
   * Optional: a dispatcher that cannot stream simply omits it, and a caller
   * that needs streaming falls back to running in-process rather than losing
   * the incremental output. Implementations must apply backpressure — the
   * consumer's reads pace the producer — or the boundary becomes a place
   * where a stream silently buffers without bound.
   */
  runSubGraphStream?(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): AsyncIterable<SubGraphStreamItem>;
}

/**
 * The dispatcher this process uses for off-thread subgraph runs.
 *
 * Unbound by default, and deliberately so: with nothing registered, a task
 * asking for `concurrencyMode: "thread"` runs in-process instead of failing.
 * Threading is an optimization, and a graph must produce the same answer on a
 * host that never set one up — a browser, a test, a CLI that spawns no
 * workers.
 */
export const SUBGRAPH_DISPATCHER = createServiceToken<ISubGraphDispatcher>(
  "taskgraph.subGraphDispatcher"
);

/**
 * Executes a {@link SubGraphRunRequest} *here*, in the current thread.
 *
 * This is the far side of the boundary: a worker entry registers it as the
 * function its `WorkerServer` exposes, and it rebuilds the graph from the
 * registry it was given. Libs ships this half because rebuilding and running a
 * graph is graph knowledge; the *entry* that registers it belongs to the
 * application, which is the only thing that knows which tasks to register and
 * how to bring up its own database and services first.
 *
 * Anything the sender held as a live object — the output cache, the resource
 * scope, the usage sinks — does NOT cross, so a subgraph run here uses
 * whatever the receiving `registry` provides and otherwise runs without them.
 * A worker that should share the host's cache binds its own repository over
 * the same store; one that binds nothing runs uncached, which is correct but
 * slower, and never wrong.
 *
 * `registry` is the receiving side's own — not the sender's, which could not
 * have crossed. It is what {@link createGraphFromGraphJSON} resolves task
 * types through, so binding a fuller `TASK_CONSTRUCTORS` map here than the
 * host CLI exposes is both possible and expected.
 */
export async function runSubGraphRequest(
  request: SubGraphRunRequest,
  registry?: ServiceRegistry,
  options?: SubGraphRunOptions
): Promise<SubGraphRunResults> {
  const graph = createGraphFromGraphJSON(request.graph, registry);

  const unsubscribe =
    options?.onProgress === undefined
      ? () => {}
      : graph.subscribe("graph_progress", (progress: number | undefined, message?: string) => {
          options.onProgress!(progress, message);
        });

  try {
    return await graph.run<TaskOutput>(request.input, {
      registry,
      parentSignal: options?.signal,
      ...request.runOptions,
    });
  } finally {
    unsubscribe();
  }
}

/**
 * One stream chunk produced inside a dispatched subgraph.
 *
 * `event` is the task's own {@link StreamEvent}, which already names the
 * output `port` it belongs to — so nothing extra has to be invented to route a
 * chunk to the right edge on the far side.
 */
export interface SubGraphStreamChunk {
  readonly taskId: unknown;
  readonly event: StreamEvent;
}

/**
 * What a streaming dispatch yields: chunks as they are produced, then exactly
 * one terminal `results` item.
 *
 * The results ride the same channel rather than being returned separately
 * because the worker run-fn protocol has one ordered stream per request and a
 * terminal message carrying no payload. Ordering on a message port is
 * guaranteed, so a consumer that reads to the end has every chunk before the
 * results it completes.
 */
/**
 * The per-task events a dispatched subgraph forwards to its parent graph.
 *
 * Exactly the set `bridgeSubGraphTaskEvents` re-emits in-process. Carried as
 * a name plus already-serializable arguments rather than as a typed union per
 * event, because the host replays them with `parentGraph.emit(name, ...args)`
 * and giving each one a shape here would be a second definition of the event
 * surface to keep in step.
 */
export const BRIDGED_SUBGRAPH_EVENTS = [
  "task_complete",
  "task_progress",
  "task_stream_start",
  "task_stream_chunk",
  "task_stream_end",
  "task_usage",
] as const;

export type BridgedSubGraphEvent = (typeof BRIDGED_SUBGRAPH_EVENTS)[number];

export interface SubGraphForwardedEvent {
  readonly name: BridgedSubGraphEvent;
  readonly args: readonly unknown[];
}

export type SubGraphStreamItem =
  | { readonly kind: "chunk"; readonly chunk: SubGraphStreamChunk }
  | { readonly kind: "event"; readonly event: SubGraphForwardedEvent }
  | { readonly kind: "results"; readonly results: SubGraphRunResults };

/**
 * Ceiling on forwarded-but-unconsumed cost inside a dispatched subgraph run.
 *
 * `task_stream_chunk` is emitted synchronously by `StreamPump`, so a forwarding
 * listener cannot park its producer — awaiting inside a listener does not stop
 * an emitter. What it can do is refuse to grow without bound: past this
 * ceiling the run fails with a diagnosable error instead of consuming the
 * worker's heap. Generous enough that a consumer keeping any reasonable pace
 * never reaches it.
 */
export const DEFAULT_FORWARD_BUFFER_LIMIT = 8 * 1024 * 1024;

/** Raised when a dispatched subgraph outruns its consumer past the ceiling. */
export class SubGraphForwardOverflowError extends Error {
  constructor(pending: number, limit: number) {
    super(
      `Dispatched subgraph outran its consumer: ${pending} cost units pending, ceiling ${limit}. ` +
        `The subgraph produces stream events faster than the caller consumes them, and ` +
        `\`task_stream_chunk\` is emitted synchronously so the producer cannot be parked. ` +
        `Consume faster, or raise forwardBufferLimit if the burst is legitimate.`
    );
    this.name = "SubGraphForwardOverflowError";
  }
}

/**
 * Runs a {@link SubGraphRunRequest} here, forwarding stream chunks as they are
 * produced instead of only returning the final outputs.
 *
 * `emit` may return a promise, and this awaits it — that is the only reason a
 * credit window can throttle anything: the transport parks the *forwarding*
 * until the consumer has taken the chunk.
 *
 * **What that backpressure does and does not reach.** It bounds what is in
 * flight across the port and held by the consumer. It does **not** reach back
 * into the subgraph to slow the task producing the chunks: `task_stream_chunk`
 * is an event, and a listener returning a promise does not stop an emitter, so
 * a fast producer with a slow consumer accumulates inside the worker rather
 * than inside the caller. That is strictly better than the unbounded-both-ends
 * behaviour it replaces — the worker is where the data already is, and the
 * caller's heap is the one that was growing — but it is not the in-process
 * guarantee, where an edge's gate parks the producing task itself. Closing
 * that gap means draining the leaf's edge stream through `StreamPump` instead
 * of subscribing to the graph's event, and is the remaining piece.
 */
export async function runSubGraphStreamRequest(
  request: SubGraphRunRequest,
  registry: ServiceRegistry | undefined,
  emit: (item: SubGraphStreamItem) => void | Promise<void>,
  options?: SubGraphRunOptions
): Promise<void> {
  const graph = createGraphFromGraphJSON(request.graph, registry);

  const limit = options?.forwardBufferLimit ?? DEFAULT_FORWARD_BUFFER_LIMIT;
  let pending = 0;
  let overflow: SubGraphForwardOverflowError | undefined;

  // Forwarding is serialized through this tail so items reach the consumer in
  // the order the graph produced them. Without it, two items emitted back to
  // back would race their awaits and could arrive transposed.
  let tail: Promise<void> = Promise.resolve();
  const forward = (item: SubGraphStreamItem): void => {
    if (overflow !== undefined) return;
    // The emitter is synchronous (`StreamPump` emits `task_stream_chunk`
    // inline), so this cannot park it — only refuse to grow past the ceiling.
    const cost = streamChunkCost(item);
    pending += cost;
    if (pending > limit) {
      overflow = new SubGraphForwardOverflowError(pending, limit);
      return;
    }
    tail = tail
      .then(() => emit(item))
      .then(
        () => {
          pending -= cost;
        },
        () => {
          pending -= cost;
        }
      );
  };

  const unsubscribeChunk = graph.subscribe(
    "task_stream_chunk",
    (taskId: unknown, event: StreamEvent) => {
      forward({ kind: "chunk", chunk: { taskId, event } });
    }
  );

  // The same per-task events `bridgeSubGraphTaskEvents` re-emits in-process,
  // so a subgraph that ran elsewhere still surfaces its children to a watching
  // parent rather than collapsing into one opaque wrapper row.
  const unsubscribeBridged = BRIDGED_SUBGRAPH_EVENTS.map((name) =>
    graph.subscribe(name, (...args: unknown[]) => {
      forward({ kind: "event", event: { name, args } });
    })
  );

  const unsubscribeProgress =
    options?.onProgress === undefined
      ? () => {}
      : graph.subscribe("graph_progress", (progress: number | undefined, message?: string) => {
          options.onProgress!(progress, message);
        });

  try {
    const results = await graph.run<TaskOutput>(request.input, {
      registry,
      parentSignal: options?.signal,
      ...request.runOptions,
    });
    // Drain the forwarding tail before the terminal item, so `results` cannot
    // overtake a chunk still waiting on the consumer.
    await tail;
    if (overflow !== undefined) throw overflow;
    await emit({ kind: "results", results });
  } finally {
    unsubscribeChunk();
    for (const off of unsubscribeBridged) off();
    unsubscribeProgress();
  }
}
