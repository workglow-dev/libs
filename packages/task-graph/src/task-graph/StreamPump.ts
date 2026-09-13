/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceScope, ServiceRegistry } from "@workglow/util";
import { getLogger } from "@workglow/util";
import type { TaskOutputRepository } from "../storage/TaskOutputRepository";
import { BackpressureGate } from "../task/BackpressureGate";
import type { ITask } from "../task/ITask";
import type { StreamEvent, StreamMode, Usage } from "../task/StreamTypes";
import {
  allStreamingPortsAreBinary,
  DEFAULT_BINARY_HIGH_WATER_BYTES,
  DEFAULT_STREAM_GATE_WATCHDOG_MS,
  edgeNeedsAccumulation,
  getOutputStreamMode,
  getPortStreamMode,
  getStreamingPorts,
  isDataflowExcluded,
  isDeltaStreamMode,
  isStreamConsumer,
  isTaskStreamable,
  portForcesStreamValidation,
  streamEventCost,
} from "../task/StreamTypes";
import type { TaskIdType, TaskInput } from "../task/TaskTypes";
import { TaskStatus } from "../task/TaskTypes";
import type { Dataflow } from "./Dataflow";
import { DATAFLOW_ALL_PORTS } from "./Dataflow";
import type { EdgeMaterializer } from "./EdgeMaterializer";
import type { RunContext } from "./RunContext";
import type { RunScheduler } from "./RunScheduler";
import type { TaskGraph } from "./TaskGraph";
import type { GraphSingleTaskResult } from "./TaskGraphRunner";
import type { ITaskGraphScheduler } from "./TaskGraphScheduler";

/**
 * Per-call run-state inputs shared between {@link StreamPump.runStreamingTask}
 * and the helpers it calls. Keeps StreamPump stateless beyond `graph`,
 * `processScheduler`, and `edgeMaterializer` so the facade's mutable per-run
 * state (`registry`, `outputCache`, `resourceScope`, `accumulateLeafOutputs`)
 * is read at call time rather than captured at construction.
 *
 * @internal
 */
export interface StreamingRunOptions {
  readonly registry: ServiceRegistry;
  readonly outputCache: TaskOutputRepository | undefined;
  readonly resourceScope: ResourceScope | undefined;
  /** Where a charge that settles after a task finished lands. */
  readonly lateUsageSink?: (taskId: string, usage: Usage, modelId: string | undefined) => void;
  /** Where an owned child's live usage snapshot lands. */
  readonly usageSink?: (taskId: string, usage: Usage, modelId: string | undefined) => void;
  /** Where an owned child's finished execution is retired. */
  readonly usageRetireSink?: (taskId: string) => void;
  readonly accumulateLeafOutputs: boolean;
  /**
   * Opt-in to the no-accumulation passthrough path for this run. Off ⇒ every
   * edge takes today's drain; the flag only matters when an edge also meets the
   * passthrough conditions. Threaded onto each streaming task's run config so
   * the runner can choose the per-port ref-sink path.
   */
  readonly noAccumulation?: boolean;
  /** High-water mark (bytes) for the no-accumulation passthrough gate. */
  readonly streamHighWaterBytes?: number;
  /**
   * Liveness watchdog (ms) for the no-accumulation passthrough gate. When
   * omitted, `DEFAULT_STREAM_GATE_WATCHDOG_MS` applies; `0` disables.
   */
  readonly streamGateWatchdogMs?: number;
  readonly updateProgress: (
    task: ITask,
    progress: number | undefined,
    message?: string,
    ...args: any[]
  ) => Promise<void>;
  /** Stable identifier for the current graph run; threaded into each task's IRunConfig. */
  readonly runId?: string;
  /**
   * True when the caller explicitly disabled caching (outputCache: false). When
   * set, `false` is passed to task.runner.run() so TaskRunner clears any stale
   * cacheRegistry rather than falling through to CACHE_REGISTRY resolution.
   */
  readonly legacyCacheExplicitlyDisabled?: boolean;
}

/**
 * Per-port pacing state for a no-accumulation passthrough edge: the gate that
 * parks the producer. Event costs are computed symmetrically at the charge
 * site (event enqueued) and the credit site (event pulled) via
 * {@link streamEventCost}, which is deterministic per event and cheap enough
 * to run twice.
 *
 * @internal
 */
interface EdgeGateState {
  readonly gate: BackpressureGate;
  /**
   * Per-gate liveness helpers: `armWatchdog` (re)starts the fail timer; the
   * consumer-side wrapper calls it on every pull/credit so a live consumer
   * keeps rearming, and only a genuinely stuck consumer trips it.
   * `abortListener` releases the ctx.signal listener installed by
   * {@link buildPassthroughEdgeGates}. `disposeWatchdog` clears any pending
   * fail timer. Both are cleared by the finally block in
   * {@link runStreamingTask}.
   */
  armWatchdog(): void;
  disposeWatchdog(): void;
  abortListener?: () => void;
}

/**
 * @internal
 * Streaming bridge. Awaits upstream streaming inputs, runs streaming tasks,
 * tees stream events to downstream edges, decides accumulation policy.
 *
 * `awaitStreamInputs` and `runStreamingTask` take per-call run-state as
 * arguments rather than holding references, because the facade's per-run
 * state (`registry`, `outputCache`, `resourceScope`, `accumulateLeafOutputs`)
 * is mutable and may be reassigned between runs. Method-arg injection lets the
 * facade pass the current values at call time.
 *
 * The {@link RunScheduler} back-reference is wired post-construction via
 * {@link setRunScheduler} to break the StreamPump <-> RunScheduler import
 * cycle (StreamPump calls RunScheduler for status pushes; RunScheduler
 * dispatches into StreamPump indirectly via facade.runTask).
 */
export class StreamPump {
  // Set after construction (mutual reference) — see setRunScheduler.
  private runScheduler!: RunScheduler;

  constructor(
    private readonly graph: TaskGraph,
    private readonly processScheduler: ITaskGraphScheduler,
    private readonly edgeMaterializer: EdgeMaterializer
  ) {}

  /**
   * Wires the {@link RunScheduler} back-reference. Must be called once after
   * construction, before any call to {@link runStreamingTask}.
   */
  setRunScheduler(rs: RunScheduler): void {
    this.runScheduler = rs;
  }

  /**
   * Tees streaming inputs for a streamable task — one copy goes to the task's
   * executeStream() (via inputStreams), one stays on the edge for materialization
   * by awaitStreamInputs.
   *
   * A no-accumulation passthrough edge is never drained downstream, so its
   * materialize copy would only pile every event up in the unread tee branch —
   * the accumulation the passthrough exists to avoid. Such an edge hands its
   * stream to the consumer directly (no tee); the edge keeps the same stream
   * reference so "this edge is streaming" checks still hold, and its settled
   * value arrives as the per-port {@link CacheRef} at producer finish.
   */
  prepareStreamingInputs(task: ITask, noAccumulation: boolean = false): void {
    const dataflows = this.graph.getSourceDataflows(task.id);
    const streamingEdges = dataflows.filter((df) => df.stream !== undefined);
    if (streamingEdges.length === 0) {
      // No live streaming edges THIS run: clear any map left by a previous
      // run (e.g. an upstream cache hit that never flipped to STREAMING), or
      // the task would read last run's consumed/closed streams instead of
      // its settled input slots.
      task.runner.inputStreams = undefined;
      return;
    }
    const inputStreams = new Map<string, ReadableStream<StreamEvent>>();
    for (const df of streamingEdges) {
      const stream = df.stream!;
      if (StreamPump.isNoAccumulationPassthroughEdge(this.graph, df, noAccumulation)) {
        inputStreams.set(df.targetTaskPortId, stream);
        continue;
      }
      const [forwardCopy, materializeCopy] = stream.tee();
      inputStreams.set(df.targetTaskPortId, forwardCopy);
      df.setStream(materializeCopy);
    }
    task.runner.inputStreams = inputStreams;
  }

  /**
   * For non-streaming downstream tasks, awaits completion of any active
   * streams on input dataflow edges, materializing their values.
   *
   * Streaming upstream tasks set a ReadableStream on outgoing edges.
   * Non-streaming downstream tasks cannot consume streams directly, so
   * this method reads each stream to completion and accumulates the
   * value (via Dataflow.awaitStreamValue) before the task reads its
   * inputs through the normal getPortData() path.
   */
  async awaitStreamInputs(
    task: ITask,
    registry: ServiceRegistry,
    noAccumulation: boolean = false
  ): Promise<void> {
    const dataflows = this.graph.getSourceDataflows(task.id);
    const streamingDataflows = dataflows.filter(
      (df) =>
        df.stream !== undefined &&
        // No-accumulation passthrough edges are NOT drained: the consumer takes
        // its data from the live stream (tee'd to executeStream) and its static
        // input slot holds the upstream per-port CacheRef. Draining here would
        // be the full-speed materialize that defeats edge backpressure.
        !StreamPump.isNoAccumulationPassthroughEdge(this.graph, df, noAccumulation)
    );
    if (streamingDataflows.length === 0) return;
    await Promise.all(
      streamingDataflows.map(async (df) => {
        await df.awaitStreamValue();
        // awaitStreamValue sets port data from the raw finish/snapshot event.
        // Apply the edge's transform chain over the materialised value so the
        // downstream task receives the transformed result. This is the sole
        // transform application for streaming edges (pushOutputFromNodeToEdges
        // deliberately skips them to avoid double-apply).
        await df.applyTransforms(registry);
      })
    );
  }

  /**
   * Runs a streaming task within the DAG.
   * Listens for stream events to:
   * - Notify the scheduler when streaming begins (unblocking downstream streamable tasks)
   * - Push stream data to outgoing dataflow edges
   * - Have the source task accumulate and emit enriched finish events for
   *   non-streaming downstream tasks (when taskNeedsAccumulation() is true)
   */
  async runStreamingTask<T>(
    task: ITask,
    input: TaskInput,
    ctx: RunContext,
    options: StreamingRunOptions
  ): Promise<GraphSingleTaskResult<T>> {
    if (!this.runScheduler) {
      throw new Error(
        "StreamPump.runStreamingTask called before setRunScheduler — facade construction is incomplete."
      );
    }
    const streamMode = getOutputStreamMode(task.outputSchema());
    const shouldAccumulate = this.taskNeedsAccumulation(
      task,
      options.outputCache,
      options.accumulateLeafOutputs,
      options.noAccumulation === true
    );

    // One gate per source port that feeds a no-accumulation passthrough edge.
    // The edge stream charges the gate as events are enqueued and credits it
    // as the consumer reads; the producer's StreamProcessor parks on the
    // `edgeBackpressure` thunk after each delta, pacing it to the consumer.
    const edgeGates = this.buildPassthroughEdgeGates(task, options, ctx);
    const edgeBackpressure = edgeGates
      ? async (port?: string): Promise<void> => {
          if (port !== undefined) {
            await edgeGates.get(port)?.gate.awaitBelowMark();
            return;
          }
          await Promise.all(Array.from(edgeGates.values(), (s) => s.gate.awaitBelowMark()));
        }
      : undefined;
    // Safety release: a passthrough consumer that reaches a terminal state
    // without reading its stream to completion (throws mid-read, gets
    // disabled, or simply ignores ctx.inputStreams) would otherwise leave the
    // producer parked at the gate forever.
    const gateCleanups: Array<() => void> = [];
    if (edgeGates) {
      for (const df of this.graph.getTargetDataflows(task.id)) {
        const state = edgeGates.get(df.sourceTaskPortId);
        if (!state) continue;
        const target = this.graph.getTask(df.targetTaskId);
        if (!target) continue;
        const onTargetStatus = (status: TaskStatus) => {
          if (
            status === TaskStatus.COMPLETED ||
            status === TaskStatus.FAILED ||
            status === TaskStatus.ABORTING ||
            status === TaskStatus.DISABLED
          ) {
            state.gate.close();
          }
        };
        target.on("status", onTargetStatus);
        gateCleanups.push(() => target.off("status", onTargetStatus));
      }
    }

    let streamingNotified = false;

    const onStatus = (status: TaskStatus) => {
      if (status === TaskStatus.STREAMING && !streamingNotified) {
        streamingNotified = true;
        this.runScheduler.pushStatusFromNodeToEdges(task, ctx, TaskStatus.STREAMING);
        this.pushStreamToEdges(task, streamMode, edgeGates);
        this.processScheduler.onTaskStreaming(task.id);
      }
    };

    // Guarded so a throwing listener on the (possibly bridged, cross-graph)
    // stream events can't propagate back into the source task's stream loop and
    // abort an otherwise-healthy run. Mirrors the guarded task_progress/
    // task_complete emits in RunScheduler.
    const onStreamStart = () => {
      try {
        this.graph.emit("task_stream_start", task.id);
      } catch (err) {
        getLogger().error("task_stream_start listener threw", { error: err });
      }
    };

    const onStreamChunk = (event: StreamEvent) => {
      try {
        this.graph.emit("task_stream_chunk", task.id, event);
      } catch (err) {
        getLogger().error("task_stream_chunk listener threw", { error: err });
      }
    };

    const onStreamEnd = (output: Record<string, any>) => {
      try {
        this.graph.emit("task_stream_end", task.id, output);
      } catch (err) {
        getLogger().error("task_stream_end listener threw", { error: err });
      }
    };

    task.on("status", onStatus);
    task.on("stream_start", onStreamStart);
    task.on("stream_chunk", onStreamChunk);
    task.on("stream_end", onStreamEnd);

    try {
      const results = await task.runner.run(input, {
        // Pass false when explicitly disabled so TaskRunner clears stale state;
        // otherwise pass the legacy repo (or undefined to use CACHE_REGISTRY).
        outputCache: options.legacyCacheExplicitlyDisabled ? false : options.outputCache,
        shouldAccumulate,
        hasStreamingConsumers: StreamPump.anyConsumerAcceptsStream(this.graph, task),
        hasMaterializingConsumers: StreamPump.anyConsumerNeedsMaterialized(this.graph, task),
        updateProgress: options.updateProgress,
        registry: options.registry,
        resourceScope: options.resourceScope,
        lateUsageSink: options.lateUsageSink,
        usageSink: options.usageSink,
        usageRetireSink: options.usageRetireSink,
        runId: options.runId,
        noAccumulation: options.noAccumulation,
        streamHighWaterBytes: options.streamHighWaterBytes,
        streamGateWatchdogMs: options.streamGateWatchdogMs,
        edgeBackpressure,
        // Sinks are installed regardless of downstream needs: when both an
        // accumulator and a router exist (downstream needs materialized + cache
        // can stream), StreamProcessor tees — accumulator drives the enriched
        // finish event for edge consumers; the router's CacheRef takes the
        // port slot in finalOutput so the queue/cache row stays small.
      });

      await this.edgeMaterializer.pushOutputFromNodeToEdges(task, results);

      return {
        id: task.id,
        type: (task.constructor as any).runtype || (task.constructor as any).type,
        data: results as T,
      };
    } finally {
      task.off("status", onStatus);
      task.off("stream_start", onStreamStart);
      task.off("stream_chunk", onStreamChunk);
      task.off("stream_end", onStreamEnd);
      for (const cleanup of gateCleanups) cleanup();
      // Idempotent: normally already closed by the edge stream's end/terminate
      // handlers; this covers runs that never flipped to STREAMING at all.
      // Also releases the ctx-abort listener and clears any pending watchdog
      // timer, so a terminated run does not leak listeners or timers.
      if (edgeGates) {
        for (const state of edgeGates.values()) {
          state.disposeWatchdog();
          state.abortListener?.();
          state.gate.close();
        }
      }
    }
  }

  /**
   * Determines whether a streaming task needs to accumulate its text-delta
   * chunks into an enriched finish event. Accumulation is needed when:
   *
   * 1. Output caching is active (the cached value must be fully materialised).
   * 2. Any outgoing dataflow edge connects a streaming output port to an input
   *    port that is not streaming with the same mode (i.e. the downstream task
   *    cannot consume a raw stream and needs a completed value).
   *
   * When accumulation is required the source task runs with shouldAccumulate=true,
   * emitting an enriched finish event that carries all accumulated port text.
   * All downstream dataflow edges share that event via tee'd streams so no
   * edge needs to re-accumulate independently.
   */
  private taskNeedsAccumulation(
    task: ITask,
    outputCache: TaskOutputRepository | undefined,
    accumulateLeafOutputs: boolean,
    noAccumulation: boolean = false
  ): boolean {
    // A non-cacheable task writes no row, so the cache is irrelevant to its
    // accumulation decision — the edge analysis below owns it. Without this
    // guard both relaxations refuse (each requires `cacheable`) and control
    // reaches the trailing `return true`, so declaring a large streaming task
    // non-cacheable made it buffer its entire output.
    if (outputCache && task.cacheable) {
      // Relaxation: when the cache can ingest a byte stream, the task streams
      // ONLY binary (any number of such ports), and no downstream edge needs
      // the materialized value, the bytes are piped straight to one cache sink
      // per port instead of being buffered into an enriched finish event. This
      // is the memory win for large binary outputs (e.g. file/image producers).
      if (StreamPump.canStreamBinaryToCache(this.graph, task, outputCache)) return false;
      // No-accumulation passthrough: under the opt-in flag, a cacheable task
      // whose streamable ports can each be sunk per-port (and no consumer needs
      // a materialized value) pipes every port straight to the cache, skipping
      // the enriched-finish buffer for all modes — the all-mode generalization
      // of the binary relaxation above.
      if (StreamPump.canStreamAllPortsToCache(this.graph, task, outputCache, noAccumulation)) {
        return false;
      }
      return true;
    }

    const outEdges = this.graph.getTargetDataflows(task.id);
    if (outEdges.length === 0) return accumulateLeafOutputs;

    const outSchema = task.outputSchema();

    for (const df of outEdges) {
      if (df.sourceTaskPortId === DATAFLOW_ALL_PORTS) {
        // Conservative: if any streaming output port exists, accumulate.
        // This covers the case where all-ports edges fan into non-streaming tasks.
        if (getStreamingPorts(outSchema).length > 0) return true;
        continue;
      }

      const targetTask = this.graph.getTask(df.targetTaskId);
      if (!targetTask) continue;
      const inSchema = targetTask.inputSchema();

      if (edgeNeedsAccumulation(outSchema, df.sourceTaskPortId, inSchema, df.targetTaskPortId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Decides whether a streaming task's binary output can be piped straight to a
   * stream-capable cache sink (skipping in-memory accumulation). True when:
   *
   * 1. The cache reports `supportsStreaming()` (NOT a
   *    `typeof saveOutputStreamPort` duck-type — a wrapper like
   *    `RunPrivateCacheRepo` may expose a concrete writer while its
   *    `supportsStreaming()` reflects the BACKING repo, so the duck-type would
   *    falsely report `true` over a non-streaming backing store).
   * 2. The task's streaming output ports are ALL binary — one or many. Each
   *    gets its own sink and its own {@link CacheRef}, so a two-artifact
   *    producer is not pushed back onto full in-memory accumulation.
   * 3. No downstream dataflow edge needs the materialized value (every consumer
   *    accepts the raw binary stream, or there are no consumers).
   *
   * Exposed as a static (taking the graph explicitly) so the decision is
   * unit-testable in isolation from a live run.
   */
  static canStreamBinaryToCache(
    graph: TaskGraph,
    task: ITask,
    outputCache: TaskOutputRepository | undefined
  ): boolean {
    // Defensive: a repository may not implement `supportsStreaming` (the base
    // class does, but test doubles / partial mocks may not). Treat anything
    // that cannot affirmatively report streaming support as non-streaming.
    if (typeof outputCache?.supportsStreaming !== "function") return false;
    if (!outputCache.supportsStreaming()) return false;
    // The sink is only built for cacheable tasks (getBinaryRefSinksByPolicy
    // refuses otherwise). Skipping accumulation for a non-cacheable task would
    // leave its binary deltas with neither an accumulator nor a sink — the
    // output would silently drop to the finish payload ({}).
    if (!task.cacheable) return false;

    // At least one streaming port, and EVERY one of them binary — see
    // {@link allStreamingPortsAreBinary} for why the mixed case must keep
    // accumulating. Such tasks take the accumulation path unless the caller
    // opts into `noAccumulation`, where `canStreamAllPortsToCache` sinks every
    // delta-mode port. Shared with TaskRunner's standalone relaxation so the
    // two cannot drift on the port-shape question.
    if (!allStreamingPortsAreBinary(task.outputSchema())) return false;

    return !StreamPump.anyConsumerNeedsMaterialized(graph, task);
  }

  /**
   * All-mode analogue of {@link canStreamBinaryToCache} for the opt-in
   * no-accumulation path. The two share a capability probe but NOT a gating
   * rule: binary ports stream to the cache unconditionally, while append /
   * object ports only do so under the flag. True when the flag is on,
   * the task is cacheable, the cache reports `supportsStreaming()`, every streaming
   * output port is a delta mode (`append` / `object` / `binary`), and no
   * downstream edge needs a materialized value. Then each port is sunk
   * independently (per-port {@link CacheRef}) and no enriched-finish buffer is
   * built. Cacheability is required because the per-port sinks are only built
   * for cacheable tasks; without them the deltas would have nowhere to go.
   */
  static canStreamAllPortsToCache(
    graph: TaskGraph,
    task: ITask,
    outputCache: TaskOutputRepository | undefined,
    noAccumulation: boolean
  ): boolean {
    if (!noAccumulation) return false;
    if (!task.cacheable) return false;
    if (typeof outputCache?.supportsStreaming !== "function") return false;
    if (!outputCache.supportsStreaming()) return false;
    const streamingPorts = getStreamingPorts(task.outputSchema());
    if (streamingPorts.length === 0) return false;
    if (!streamingPorts.every((p) => isDeltaStreamMode(p.mode))) return false;
    return !StreamPump.anyConsumerNeedsMaterialized(graph, task);
  }

  /**
   * True when {@link df} is a no-accumulation passthrough edge: the flag is on,
   * the edge carries an active stream with no transforms, its source and target
   * ports declare the SAME delta stream mode (`append` / `object` / `binary`),
   * the source port fans out to this single consumer, and the target port does
   * not force stream validation (`x-validate-stream`). Such an edge skips the
   * materialize drain — the consumer reads the live stream and its static slot
   * holds the upstream {@link CacheRef}. Every other edge falls back to the
   * drain (correct, just no backpressure win).
   */
  static isNoAccumulationPassthroughEdge(
    graph: TaskGraph,
    df: Dataflow,
    noAccumulation: boolean
  ): boolean {
    if (!noAccumulation) return false;
    if (df.sourceTaskPortId === DATAFLOW_ALL_PORTS) return false;
    if (df.getTransforms().length > 0) return false;
    const source = graph.getTask(df.sourceTaskId);
    const target = graph.getTask(df.targetTaskId);
    if (!source || !target) return false;
    // The consumer must actually take its data from the live stream: only
    // tasks that produce a stream OR consume one receive ctx.inputStreams
    // (prepareStreamingInputs is gated on the same pair), so a target that
    // does neither still needs the drain to materialize its value. Subgraph
    // hosts (GraphAsTask etc.) also need the drain — their inner tasks read
    // the settled input slot, which the passthrough leaves unmaterialized.
    if ((!isTaskStreamable(target) && !isStreamConsumer(target)) || target.hasChildren()) {
      return false;
    }
    const srcMode = getPortStreamMode(source.outputSchema(), df.sourceTaskPortId);
    if (!isDeltaStreamMode(srcMode)) return false;
    if (getPortStreamMode(target.inputSchema(), df.targetTaskPortId) !== srcMode) return false;
    if (portForcesStreamValidation(target.inputSchema(), df.targetTaskPortId)) {
      return false;
    }
    // Single consumer of this source port: a fan-out source port must keep the
    // drain (the precise-pacing limitation is documented for multi-consumer).
    const fanout = graph
      .getTargetDataflows(df.sourceTaskId)
      .filter((e) => e.sourceTaskPortId === df.sourceTaskPortId);
    return fanout.length === 1;
  }

  /**
   * Returns `true` when any outgoing dataflow edge from {@link task} has a
   * target task whose input port can't consume the source's stream mode
   * directly (per {@link edgeNeedsAccumulation}). Independent of the cache —
   * used by the graph runner to decide whether to inhibit binary-stream sinks
   * on the source task's runner (refs can't survive across an edge whose
   * target expects a materialized value).
   *
   * Treats fan-out `*` edges as always-needs-materialized (conservative).
   */
  static anyConsumerNeedsMaterialized(graph: TaskGraph, task: ITask): boolean {
    const outSchema = task.outputSchema();
    const outEdges = graph.getTargetDataflows(task.id);
    return outEdges.some((df) => {
      if (df.sourceTaskPortId === DATAFLOW_ALL_PORTS) return true;
      const targetTask = graph.getTask(df.targetTaskId);
      if (!targetTask) return false;
      return edgeNeedsAccumulation(
        outSchema,
        df.sourceTaskPortId,
        targetTask.inputSchema(),
        df.targetTaskPortId
      );
    });
  }

  /**
   * Returns `true` when any outgoing edge targets an input port that consumes
   * the source port's delta stream mode directly (same `append` / `object` /
   * `binary` mode on both ends). Drives whether a cache hit replays the cached
   * bytes as delta events (via the per-mode codec) for a stream-capable
   * consumer; `*` fan-out edges don't count (their consumers receive
   * materialized values).
   */
  static anyConsumerAcceptsStream(graph: TaskGraph, task: ITask): boolean {
    const outSchema = task.outputSchema();
    return graph.getTargetDataflows(task.id).some((df) => {
      if (df.sourceTaskPortId === DATAFLOW_ALL_PORTS) return false;
      const srcMode = getPortStreamMode(outSchema, df.sourceTaskPortId);
      if (!isDeltaStreamMode(srcMode)) return false;
      const targetTask = graph.getTask(df.targetTaskId);
      if (!targetTask) return false;
      return getPortStreamMode(targetTask.inputSchema(), df.targetTaskPortId) === srcMode;
    });
  }

  /**
   * Builds one {@link EdgeGateState} per source port whose (single) outgoing
   * edge qualifies as a no-accumulation passthrough AND whose consumer can
   * make read progress while this producer is parked. The gate's high-water
   * mark is the run's `streamHighWaterBytes` (falling back to
   * {@link DEFAULT_BINARY_HIGH_WATER_BYTES}). Returns `undefined` when the flag
   * is off or no edge qualifies, so the entire pacing path stays dormant.
   *
   * Liveness guard: the producer may park on a gate long before it finishes,
   * so the consumer must be able to reach its stream reads without waiting on
   * anything that itself waits on this producer. Any OTHER edge into the
   * consumer whose source is this producer or one of its descendants — a
   * drained streaming edge, a mode-mismatched edge, a static-value edge —
   * settles only after this producer finishes, so gating would deadlock the
   * pair. Such consumers keep the ungated passthrough (correct, just unpaced).
   */
  private buildPassthroughEdgeGates(
    task: ITask,
    options: StreamingRunOptions,
    ctx: RunContext
  ): Map<string, EdgeGateState> | undefined {
    if (options.noAccumulation !== true) return undefined;
    const highWaterMark =
      options.streamHighWaterBytes !== undefined && options.streamHighWaterBytes > 0
        ? options.streamHighWaterBytes
        : DEFAULT_BINARY_HIGH_WATER_BYTES;
    const watchdogMs =
      options.streamGateWatchdogMs !== undefined
        ? options.streamGateWatchdogMs
        : DEFAULT_STREAM_GATE_WATCHDOG_MS;
    let reachable: ReadonlySet<TaskIdType> | undefined;
    let gates: Map<string, EdgeGateState> | undefined;
    for (const df of this.graph.getTargetDataflows(task.id)) {
      if (!StreamPump.isNoAccumulationPassthroughEdge(this.graph, df, true)) continue;
      reachable ??= this.tasksReachableFrom(task.id);
      const consumerWaitsOnProducer = this.graph
        .getSourceDataflows(df.targetTaskId)
        .some((e) => e !== df && reachable!.has(e.sourceTaskId));
      if (consumerWaitsOnProducer) continue;
      // The passthrough predicate guarantees a single consumer per source
      // port, so one gate per port is exactly one gate per edge.
      gates ??= new Map();
      const gate = new BackpressureGate(highWaterMark);

      // Liveness: an aborted run must release the parked producer immediately
      // (otherwise the consumer's abort-triggered close listener is the only
      // release path, and any code path that skips that listener wedges the
      // run). A watchdog timer additionally trips fail() when a producer stays
      // parked without any pull/credit progress for `watchdogMs`, surfacing a
      // dead consumer as a run-level error instead of a wedged process.
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog =
        watchdogMs > 0
          ? () => {
              if (watchdogTimer) clearTimeout(watchdogTimer);
              watchdogTimer = setTimeout(() => {
                // Only a producer parked (or about to park) at the high-water
                // mark can be wedged by a dead consumer. Below the mark the
                // gate is merely idle — a slow producer, an upstream stall, a
                // pause between deltas — and nothing is waiting on a pull or
                // credit, so re-arm instead of failing a healthy run.
                if (!gate.isAboveMark) {
                  armWatchdog();
                  return;
                }
                gate.fail(
                  new Error(
                    `Passthrough edge gate stalled for ${watchdogMs}ms without pull or credit progress.`
                  )
                );
              }, watchdogMs);
            }
          : () => {};
      const disposeWatchdog = () => {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = undefined;
        }
      };
      const onAbort = () => gate.close();
      ctx.abortController.signal.addEventListener("abort", onAbort, { once: true });

      const state: EdgeGateState = {
        gate,
        armWatchdog,
        disposeWatchdog,
        abortListener: () => ctx.abortController.signal.removeEventListener("abort", onAbort),
      };
      // Arm the watchdog immediately so a consumer that never even starts
      // reading still trips it — otherwise the first arm only happens on
      // the first pull, and a wedged consumer that never reads keeps the
      // watchdog dormant.
      armWatchdog();
      gates.set(df.sourceTaskPortId, state);
    }
    return gates;
  }

  /** Task ids reachable from `taskId` via outgoing dataflows, including itself. */
  private tasksReachableFrom(taskId: TaskIdType): ReadonlySet<TaskIdType> {
    const seen = new Set<TaskIdType>([taskId]);
    const queue: TaskIdType[] = [taskId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const df of this.graph.getTargetDataflows(id)) {
        if (!seen.has(df.targetTaskId)) {
          seen.add(df.targetTaskId);
          queue.push(df.targetTaskId);
        }
      }
    }
    return seen;
  }

  /**
   * Wraps a per-port edge stream so every event read by the consumer credits
   * the port's gate with that event's {@link streamEventCost} — the same
   * deterministic cost the charge site computed when the event was enqueued —
   * waking a producer parked at the high-water mark. Close (end, cancel, or
   * an upstream read failure) also closes the gate so an abandoned consumer
   * can never orphan a parked producer.
   */
  private static wrapStreamWithGateCredit(
    stream: ReadableStream<StreamEvent>,
    state: EdgeGateState
  ): ReadableStream<StreamEvent> {
    const reader = stream.getReader();
    return new ReadableStream<StreamEvent>({
      async pull(controller) {
        // Every pull is progress: rearm the watchdog so a live consumer keeps
        // resetting the fail timer for as long as it keeps reading.
        state.armWatchdog();
        let done: boolean;
        let value: StreamEvent | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          state.gate.close();
          throw err;
        }
        if (done || value === undefined) {
          state.gate.close();
          controller.close();
          return;
        }
        state.gate.credit(streamEventCost(value));
        state.armWatchdog();
        controller.enqueue(value);
      },
      cancel(reason) {
        state.gate.close();
        return reader.cancel(reason);
      },
    });
  }

  /**
   * Returns true if an event carries a port-specific delta (text-delta,
   * object-delta, or binary-delta).
   */
  private static isPortDelta(event: StreamEvent): event is StreamEvent & { port: string } {
    return (
      event.type === "text-delta" || event.type === "object-delta" || event.type === "binary-delta"
    );
  }

  /**
   * Creates a ReadableStream from task streaming events, optionally filtered
   * to a single port. When `portId` is undefined (DATAFLOW_ALL_PORTS), all
   * events pass through. When set, only delta events matching the port plus
   * control events (finish, error, snapshot) are enqueued.
   *
   * Also taps snapshot events to write per-port data into each edge's
   * `latestSnapshot` slot for downstream peek-during-streaming.
   *
   * When a `gate` is supplied (no-accumulation passthrough), every enqueued
   * event charges the gate with its {@link streamEventCost}; the consumer-side
   * wrapper ({@link wrapStreamWithGateCredit}) credits it back on each read.
   * Stream end and producer abort/error close the gate so a parked producer
   * is always released.
   */
  private createStreamFromTaskEvents(
    task: ITask,
    portId: string | undefined,
    edgesForGroup: ReadonlyArray<Dataflow>,
    gate?: EdgeGateState
  ): ReadableStream<StreamEvent> {
    // Shared teardown closure — hoisted out of start() so cancel() (which the
    // ReadableStream invokes on reader.cancel()) can call it too. Without this,
    // a downstream that aborts mid-stream leaves every listener still attached.
    let cleanup: () => void = () => {};
    return new ReadableStream<StreamEvent>({
      start: (controller) => {
        // Single teardown path: closes the controller and detaches every
        // listener this stream added. Invoked on normal stream_end AND on a
        // terminal task status (FAILED/COMPLETED), because StreamProcessor does
        // not emit stream_end on the error/abort path — without the status
        // fallback the controller and listeners would leak (and a downstream
        // consumer awaiting `done` would hang) on failed/aborted source tasks.
        let closed = false;
        cleanup = () => {
          if (closed) return;
          closed = true;
          // Release any producer parked on this port's passthrough gate —
          // every teardown path (end, terminal status, reader cancel) must
          // wake it or the run hangs.
          gate?.gate.close();
          try {
            controller.close();
          } catch {
            // Stream may already be closed
          }
          task.off("stream_chunk", onChunk);
          task.off("stream_end", onEnd);
          task.off("status", onStatus);
        };
        const onChunk = (event: StreamEvent) => {
          try {
            if (portId !== undefined && StreamPump.isPortDelta(event) && event.port !== portId) {
              return;
            }
            // A task's own reporting is not content on a port, so it never
            // reaches an edge. The port filter above cannot decide this: it
            // recognises only the three delta types, so an event carrying no
            // `port` passes it by construction.
            if (isDataflowExcluded(event)) {
              return;
            }
            // Tap: on snapshot events, write per-port data into each edge's
            // latestSnapshot slot.
            if (event.type === "snapshot") {
              const data = event.data as Record<string, unknown> | undefined;
              if (data) {
                for (const edge of edgesForGroup) {
                  const portValue =
                    edge.sourceTaskPortId === DATAFLOW_ALL_PORTS
                      ? data
                      : data[edge.sourceTaskPortId];
                  edge.latestSnapshot = portValue;
                }
              }
            }
            if (gate) {
              gate.gate.account(streamEventCost(event));
            }
            controller.enqueue(event);
          } catch {
            // Stream may be closed
          }
        };
        const onEnd = () => {
          cleanup();
        };
        const onStatus = (status: TaskStatus) => {
          // Terminal statuses with no stream_end (error/abort -> FAILED, or a
          // completion that bypassed stream_end) must still release the stream.
          // A producer FAILURE first surfaces in-stream so a drained edge
          // materializes the error instead of quietly settling on whatever
          // partial data had arrived — a consumer already dispatched
          // (unblocked at STREAMING) must not complete, and cache, an output
          // derived from truncated input. Abort closes gracefully (the
          // run-level abort cascade is already tearing everything down).
          if (status === TaskStatus.FAILED) {
            try {
              controller.enqueue({
                type: "error",
                error: task.error ?? new Error(`Task ${task.type} failed during streaming`),
              } as StreamEvent);
            } catch {
              // Stream may already be closed
            }
            cleanup();
          } else if (status === TaskStatus.COMPLETED || status === TaskStatus.ABORTING) {
            cleanup();
          }
        };
        task.on("stream_chunk", onChunk);
        task.on("stream_end", onEnd);
        task.on("status", onStatus);
      },
      cancel: (_reason) => {
        // Reader cancellation MUST release the listeners. Without this, a
        // downstream that aborts mid-stream (e.g. a consumer hit its limit,
        // an upstream task failed and tore down its child stream) leaves
        // every listener still attached — the task continues to emit events
        // into a closed controller and the leaked listeners pin GC. `cleanup`
        // is idempotent (the `closed` flag), so concurrent cancel + stream_end
        // is safe.
        cleanup();
      },
    });
  }

  /**
   * Pushes stream events from a streaming task to its outgoing dataflow edges.
   * Creates per-port filtered ReadableStreams for specific-port edges and
   * unfiltered streams for DATAFLOW_ALL_PORTS edges. Within each port group,
   * uses tee() for fan-out to multiple consumers.
   *
   * A port with an entry in `edgeGates` (single passthrough consumer by
   * construction) gets a gate-instrumented stream: events charge the gate as
   * they are enqueued and credit it as the consumer reads, so the producer can
   * park against the consumer's read rate. Fan-out groups never have a gate —
   * multi-consumer pacing stays best-effort.
   */
  private pushStreamToEdges(
    task: ITask,
    _streamMode: StreamMode,
    edgeGates?: ReadonlyMap<string, EdgeGateState>
  ): void {
    const targetDataflows = this.graph.getTargetDataflows(task.id);
    if (targetDataflows.length === 0) return;

    // Group edges by their source port
    const groups = new Map<string, typeof targetDataflows>();
    for (const df of targetDataflows) {
      const key = df.sourceTaskPortId;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(df);
    }

    for (const [portKey, edges] of groups) {
      const filterPort = portKey === DATAFLOW_ALL_PORTS ? undefined : portKey;
      // Gates exist only for single-consumer passthrough ports; a gate on a
      // multi-edge group cannot happen by construction, but guard anyway so a
      // tee'd fan-out is never double-credited.
      const gate =
        filterPort !== undefined && edges.length === 1 ? edgeGates?.get(filterPort) : undefined;
      const stream = this.createStreamFromTaskEvents(task, filterPort, edges, gate);

      if (edges.length === 1) {
        edges[0].setStream(gate ? StreamPump.wrapStreamWithGateCredit(stream, gate) : stream);
      } else {
        let currentStream = stream;
        for (let i = 0; i < edges.length; i++) {
          if (i === edges.length - 1) {
            edges[i].setStream(currentStream);
          } else {
            const [s1, s2] = currentStream.tee();
            edges[i].setStream(s1);
            currentStream = s2;
          }
        }
      }
    }
  }
}
