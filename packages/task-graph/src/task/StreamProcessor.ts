/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceScope, ServiceRegistry } from "@workglow/util";
import { getLogger } from "@workglow/util";
import type { CacheRef } from "../cache/CacheRef";
import type { CacheRegistry } from "../cache/CacheRegistry";
import type { StreamPortCodec } from "../cache/streamCodec";
import { getStreamPortCodec } from "../cache/streamCodec";
import type { Taskish } from "../task-graph/Conversions";
import { BackpressureGate } from "./BackpressureGate";
import type { ConfigNotApplicableToAnExistingTask, ITask } from "./ITask";
import type { StreamEvent, StreamMode, Usage } from "./StreamTypes";
import {
  assertBinaryFormat,
  DEFAULT_BINARY_HIGH_WATER_BYTES,
  foldObjectDelta,
  getOutputStreamMode,
  getStreamingPorts,
  materializeBinary,
  mergeUsage,
  REFUSAL_CATEGORY_OUTPUT_KEY,
  REFUSAL_OUTPUT_KEY,
  USAGE_OUTPUT_KEY,
} from "./StreamTypes";
import { TaskAbortedError, TaskError } from "./TaskError";
import type { TaskRunContext } from "./TaskRunContext";
import type { TaskConfig, TaskInput, TaskOutput } from "./TaskTypes";
import { TaskStatus } from "./TaskTypes";

/**
 * Consumer for a port's binary-delta stream. The processor exposes chunks as
 * an async iterable; the sink returns the {@link CacheRef} the processor
 * places into `Output` at the port slot.
 *
 * Implementations are typically thin wrappers around
 * `TaskOutputRepository.saveOutputStreamPort` — the runner supplies the wrapper
 * once it knows the cache key.
 */
export type BinaryRefSink = (chunks: AsyncIterable<Uint8Array>) => Promise<CacheRef>;

/**
 * A per-port stream sink generalized to any streamable mode. `mode` selects the
 * codec the processor uses to encode that port's deltas (`append` → UTF-8,
 * `object` → NDJSON, `binary` → identity) before handing the ordered bytes to
 * `write`, which persists them and returns the {@link CacheRef} the processor
 * places into `Output` at the port slot (subject to the same artifact
 * precedence as the binary path: an explicit whole finish payload wins).
 *
 * A `binary`-mode sink is exactly the legacy {@link BinaryRefSink} with its
 * mode named; the two are interchangeable on the wire (bytes in, ref out).
 */
export interface StreamSink {
  readonly mode: StreamMode;
  readonly write: BinaryRefSink;
}

/**
 * Per-call run-state inputs shared by StreamProcessor.run. Bundles facade
 * state pulled at call time (registry, resourceScope, inputStreams) and
 * facade methods bound to the facade instance (onProgress, own).
 *
 * @internal
 */
export interface StreamProcessorDeps {
  readonly registry: ServiceRegistry;
  /**
   * The run's resolved cache, forwarded verbatim to
   * {@link IExecuteContext.cacheRegistry}. Streaming tasks reach it on the same
   * terms non-streaming ones do — a task whose correctness turns on whether its
   * output will be stored must not get a different answer for implementing
   * `executeStream()`.
   */
  readonly cacheRegistry: CacheRegistry | undefined;
  readonly resourceScope: ResourceScope | undefined;
  readonly inputStreams: Map<string, ReadableStream<StreamEvent>> | undefined;
  readonly onProgress: (
    progress: number | undefined,
    message?: string,
    ...args: any[]
  ) => Promise<void>;
  readonly own: <T extends Taskish<any, any>>(
    i: T,
    config?: TaskConfig | ConfigNotApplicableToAnExistingTask
  ) => T;
  readonly disown: <T extends Taskish<any, any>>(i: T) => void;
  /**
   * Per-port stream sinks, one per streamable mode (`append` / `object` /
   * `binary`). When a port has a sink registered, the processor encodes that
   * port's deltas via the sink's mode codec and routes the bytes to the sink
   * **instead** of accumulating them in memory; at finish the sink's
   * {@link CacheRef} replaces the port slot in the output (unless an explicit
   * whole finish payload is present for that port, which always wins —
   * artifact precedence). Ports without a sink follow the normal accumulation
   * path. A legacy single-binary-port sink is expressed as a `binary`-mode
   * entry (its {@link BinaryRefSink} as `write`).
   */
  readonly refSinks?: ReadonlyMap<string, StreamSink>;
  /**
   * High-water mark (bytes) for the per-port stream router buffer. When the
   * buffered (un-consumed) byte total reaches or exceeds this value,
   * `BinaryStreamRouter.push()` returns a Promise that resolves only after the
   * consumer drains the buffer back below the mark. Defaults to
   * {@link DEFAULT_BINARY_HIGH_WATER_BYTES} when omitted.
   */
  readonly streamHighWaterBytes?: number;
  /**
   * Consumer-edge backpressure for the no-accumulation passthrough path,
   * threaded down from the graph runner (see `IRunConfig.edgeBackpressure`).
   * After emitting a delta the processor awaits this with the event's port so
   * the producer is paced to that port's consumer read rate; the cooperative
   * `IExecuteContext.backpressure` hook awaits it with no argument (all
   * ports). Absent on standalone runs — the processor then paces only against
   * its own cache-sink routers.
   */
  readonly edgeBackpressure?: (port?: string) => Promise<void>;
}

/**
 * @internal
 * Streaming event loop. Consumes a task's executeStream() output, manages
 * text/object delta accumulators, mode switching (append/object/replace),
 * and finish-event enrichment. Honors ctx.shouldAccumulate and
 * ctx.abortController.signal.
 */
export class StreamProcessor<Input extends TaskInput, Output extends TaskOutput> {
  constructor(private readonly task: ITask<Input, Output, any>) {}

  /**
   * A `replace`-mode stream finished with an empty payload and no preceding
   * snapshot — the producer delivered no value. Returning the empty object
   * would silently clear the output, so surface a clear error instead.
   */
  private replaceModeNoValueError(): TaskError {
    return new TaskError(
      `Task ${this.task.type} declares replace streaming but finished with no value: ` +
        `a replace-mode task must emit a final snapshot or a non-empty finish payload.`
    );
  }

  async run(
    input: Input,
    ctx: TaskRunContext,
    deps: StreamProcessorDeps
  ): Promise<Output | undefined> {
    const streamMode: StreamMode = getOutputStreamMode(this.task.outputSchema());
    if (streamMode === "append") {
      const ports = getStreamingPorts(this.task.outputSchema());
      if (ports.length === 0) {
        throw new TaskError(
          `Task ${this.task.type} declares append streaming but no output port has x-stream: "append"`
        );
      }
    }
    if (streamMode === "object") {
      const ports = getStreamingPorts(this.task.outputSchema());
      if (ports.length === 0) {
        throw new TaskError(
          `Task ${this.task.type} declares object streaming but no output port has x-stream: "object"`
        );
      }
    }

    const accumulated = ctx.shouldAccumulate ? new Map<string, string>() : undefined;
    const accumulatedObjects = ctx.shouldAccumulate
      ? new Map<string, Record<string, unknown> | unknown[]>()
      : undefined;
    const accumulatedBinary = ctx.shouldAccumulate ? new Map<string, Uint8Array[]>() : undefined;
    const sinks = deps.refSinks;
    const highWaterMark =
      deps.streamHighWaterBytes !== undefined && deps.streamHighWaterBytes > 0
        ? deps.streamHighWaterBytes
        : DEFAULT_BINARY_HIGH_WATER_BYTES;
    // Per-port routers: lazily created on the first delta whose port has a sink.
    // Routes codec-encoded bytes to the sink instead of accumulating in memory;
    // at finish, awaits the sink's returned CacheRef and writes it into the
    // output at the port slot. The codec (chosen by the sink's mode) turns each
    // text/object/binary delta into the ordered bytes the sink persists.
    const routers = new Map<string, { router: BinaryStreamRouter; codec: StreamPortCodec }>();
    const ensureRouter = (
      port: string
    ): { router: BinaryStreamRouter; codec: StreamPortCodec } | undefined => {
      const sink = sinks?.get(port);
      if (!sink) return undefined;
      let r = routers.get(port);
      if (!r) {
        r = {
          router: new BinaryStreamRouter(sink.write, highWaterMark),
          codec: getStreamPortCodec(sink.mode),
        };
        routers.set(port, r);
      }
      return r;
    };
    // Encode `event` for `port` via its sink codec and park the producer on the
    // router's byte-bounded gate. No-op when the port has no sink.
    const routeDelta = async (port: string, event: StreamEvent): Promise<void> => {
      const r = ensureRouter(port);
      if (!r) return;
      const bytes = r.codec.encodeEvent(event, port);
      if (bytes) await r.router.push(bytes);
    };

    let streamingStarted = false;
    let finalOutput: Output | undefined;
    let refusalText = "";
    let refusalCategory: string | undefined;
    // Two accumulators, because a `usage` event is a CUMULATIVE snapshot of the
    // in-flight call while `finish` states that call's total. Merging snapshots
    // additively would count the same tokens once per event.
    let settledUsage: Usage | undefined;
    let liveUsage: Usage | undefined;
    const runningUsage = (): Usage | undefined => mergeUsage(settledUsage, liveUsage);
    const publishRunning = (): void => {
      const running = runningUsage();
      // Assign unconditionally: when the finish handler clears an unpromotable
      // estimate there is nothing running, and an early return here would leave
      // `runUsage` holding that estimate as if it were the settled total.
      this.task.runUsage = running;
      if (!running) return;
      try {
        this.task.emit("usage", running, this.task.runUsageModelId);
      } catch (err) {
        getLogger().error("usage listener threw", { taskId: this.task.id, error: err });
      }
    };

    this.task.emit("stream_start");

    // Cooperative backpressure hook for executeStream() implementations that
    // emit through a side channel (not StreamProcessor's awaited per-event
    // path). `await ctx.backpressure()` waits until ALL active cache-sink
    // routers AND any consumer-edge gate are back below their high-water
    // marks. With no router and no edge gate this is a cheap no-op.
    const backpressure = async (): Promise<void> => {
      const waits: Promise<void>[] = [];
      for (const { router } of routers.values()) {
        if (router._bufferedBytes >= router._highWaterMarkBytes) waits.push(router._awaitDrain());
      }
      if (deps.edgeBackpressure) waits.push(deps.edgeBackpressure());
      if (waits.length === 0) return;
      await Promise.all(waits);
    };

    const stream = this.task.executeStream!(input, {
      signal: ctx.abortController.signal,
      updateProgress: deps.onProgress,
      own: deps.own,
      disown: deps.disown,
      registry: deps.registry,
      cacheRegistry: deps.cacheRegistry,
      resourceScope: deps.resourceScope,
      inputStreams: deps.inputStreams,
      backpressure,
    });

    let sawFinish = false;
    try {
      for await (const event of stream) {
        // For snapshot events, update runOutputData BEFORE emitting stream_chunk
        // so listeners see the latest snapshot when they handle the event.
        if (event.type === "snapshot") {
          this.task.runOutputData = event.data as Output;
        }

        switch (event.type) {
          case "phase": {
            // Phase events are metadata: emit for observability, translate to a
            // progress event with optional progress + message, do NOT mutate
            // accumulators or runOutputData, do NOT flip status to STREAMING.
            this.task.emit("stream_chunk", event as StreamEvent);
            await deps.onProgress(event.progress, event.message);
            break;
          }
          case "text-delta": {
            if (!streamingStarted) {
              streamingStarted = true;
              this.task.status = TaskStatus.STREAMING;
              this.task.emit("status", this.task.status);
            }
            if (accumulated) {
              accumulated.set(event.port, (accumulated.get(event.port) ?? "") + event.textDelta);
            }
            // Tee to the port's sink (encoded as UTF-8) when one exists; the
            // accumulator (if any) still drives the enriched finish event.
            await routeDelta(event.port, event);
            this.task.emit("stream_chunk", event as StreamEvent);
            // Pace the producer to this port's consumer read rate on a
            // passthrough edge (no-op elsewhere): the emit above charged the
            // edge gate; park here until the consumer drains below the mark.
            if (deps.edgeBackpressure) await deps.edgeBackpressure(event.port);
            break;
          }
          case "object-delta": {
            if (!streamingStarted) {
              streamingStarted = true;
              this.task.status = TaskStatus.STREAMING;
              this.task.emit("status", this.task.status);
            }
            if (accumulatedObjects) {
              accumulatedObjects.set(
                event.port,
                foldObjectDelta(accumulatedObjects.get(event.port), event.objectDelta)
              );
            }
            // Update runOutputData with accumulated state so listeners see growing state
            this.task.runOutputData = {
              ...this.task.runOutputData,
              [event.port]: accumulatedObjects?.get(event.port) ?? event.objectDelta,
            } as Output;
            // Tee to the port's sink (encoded as NDJSON) when one exists.
            await routeDelta(event.port, event);
            this.task.emit("stream_chunk", event as StreamEvent);
            if (deps.edgeBackpressure) await deps.edgeBackpressure(event.port);
            break;
          }
          case "binary-delta": {
            if (!streamingStarted) {
              streamingStarted = true;
              this.task.status = TaskStatus.STREAMING;
              this.task.emit("status", this.task.status);
            }
            // Tee: when both a router AND an accumulator exist
            // for this port (graph context where the cache can stream but a
            // downstream edge needs the materialized value), push to BOTH —
            // router writes to the cache for the small ref-bearing Output,
            // accumulator drives the enriched finish event so edge consumers
            // still receive a Blob/ArrayBuffer.
            // `routeDelta` is where byte-bounded backpressure takes effect: the
            // producer (executeStream) parks until the sink drains the router
            // buffer back under the high-water mark, or until the router is
            // closed (abort/error path).
            await routeDelta(event.port, event);
            if (accumulatedBinary) {
              const arr = accumulatedBinary.get(event.port) ?? [];
              arr.push(event.binaryDelta);
              accumulatedBinary.set(event.port, arr);
            }
            this.task.emit("stream_chunk", event as StreamEvent);
            if (deps.edgeBackpressure) await deps.edgeBackpressure(event.port);
            break;
          }
          case "snapshot": {
            if (!streamingStarted) {
              streamingStarted = true;
              this.task.status = TaskStatus.STREAMING;
              this.task.emit("status", this.task.status);
            }
            this.task.emit("stream_chunk", event as StreamEvent);
            break;
          }
          case "usage": {
            // Replace, never merge: the snapshot restates the call's running
            // total. Metadata only — no status flip, no accumulator mutation.
            liveUsage = event.usage;
            publishRunning();
            this.task.emit("stream_chunk", event as StreamEvent);
            break;
          }
          case "tool-call": {
            // Where one tool call has got to. Metadata only, like `phase`: no
            // accumulator, no runOutputData, no status flip — a task is not
            // streaming its output because something it called started.
            this.task.emit("stream_chunk", event as StreamEvent);
            break;
          }
          case "finish": {
            sawFinish = true;
            // finish supersedes the snapshots it summarizes; `?? liveUsage`
            // keeps a provider that emitted snapshots but no finish usage —
            // unless that snapshot is a character-count estimate, which is
            // display feedback and must not settle as this run's spend.
            const promotable = liveUsage?.estimated ? undefined : liveUsage;
            settledUsage = mergeUsage(settledUsage, event.usage ?? promotable);
            liveUsage = undefined;
            publishRunning();
            // Re-attached to every finish this processor constructs below, so a
            // downstream StreamPump consumer sees the same token counts the
            // provider reported. Spread conditionally: an unreported usage must
            // leave no key at all rather than an explicit `usage: undefined`.
            const usageOnEvent = event.usage ? { usage: event.usage } : {};
            // `accumulated` witnesses all three accumulator maps — they are
            // created together under one `ctx.shouldAccumulate` ternary.
            const hasEnrichment = accumulated !== undefined || routers.size > 0;
            if (hasEnrichment) {
              // Emit an enriched finish event: merge accumulated deltas into
              // the finish payload so downstream dataflows get complete port data
              // without needing to re-accumulate themselves.
              const explicitPayload = (event.data || {}) as Record<string, unknown>;
              const merged: Record<string, unknown> = { ...explicitPayload };
              if (accumulated) {
                for (const [port, text] of accumulated) {
                  if (text.length > 0) merged[port] = text;
                }
              }
              if (accumulatedObjects) {
                for (const [port, obj] of accumulatedObjects) {
                  merged[port] = obj;
                }
              }
              if (accumulatedBinary) {
                const outSchema = this.task.outputSchema();
                for (const [port, chunks] of accumulatedBinary) {
                  // Explicit binary finish payload wins. (Unlike text/object
                  // deltas above, which overwrite event.data, binary yields to
                  // an explicit payload — it's a whole artifact, not a partial.)
                  if (port in explicitPayload) continue;
                  const format = assertBinaryFormat(outSchema, port);
                  merged[port] = materializeBinary(chunks, format);
                }
              }
              // Close routers and collect refs. Explicit binary finish payload
              // still wins for the OUTPUT slot (artifact precedence); the
              // router's CacheRef is discarded in that case but the cache
              // write already happened.
              for (const { router } of routers.values()) router.end();
              const refs = new Map<string, CacheRef>();
              for (const [port, { router }] of routers) {
                if (port in explicitPayload) {
                  // Drain the promise so the sink doesn't leak; ignore the ref.
                  router.ref().catch(() => {});
                  continue;
                }
                refs.set(port, await router.ref());
              }
              // For replace-mode streams, finish carries data: {} by convention.
              // Fall back to the last snapshot (runOutputData) so the final output
              // is not silently cleared when the finish payload is empty —
              // overlaying router refs on top so cache-written bytes are not
              // orphaned (the ref still lands in the OUTPUT slot).
              if (streamMode === "replace" && Object.keys(merged).length === 0) {
                const lastSnapshot = this.task.runOutputData;
                if (lastSnapshot && Object.keys(lastSnapshot).length > 0) {
                  const snapshotWithRefs: Record<string, unknown> = { ...lastSnapshot };
                  for (const [port, ref] of refs) snapshotWithRefs[port] = ref;
                  finalOutput = snapshotWithRefs as Output;
                  this.task.emit("stream_chunk", {
                    type: "finish",
                    data: lastSnapshot,
                    ...usageOnEvent,
                  } as StreamEvent);
                  break;
                }
                // No accumulated deltas, no explicit finish payload, and no
                // snapshot to fall back on — the producer never delivered a
                // value. A binary port may still have written a ref, and a
                // refusal-terminated stream legitimately carries no value (the
                // post-loop fold surfaces it on `output.refusal` and the task
                // COMPLETES); only the truly empty case is a bug.
                if (refs.size === 0 && refusalText.length === 0) {
                  throw this.replaceModeNoValueError();
                }
              }
              // The emitted finish event always carries the materialized payload
              // (from accumulators) so edge consumers see Blob/ArrayBuffer.
              // finalOutput diverges only when a router produced a ref for a
              // port that wasn't already pinned by an explicit payload — that
              // ref takes the slot in the return value so the queue/cache row
              // stays small (the tee path).
              this.task.emit("stream_chunk", {
                type: "finish",
                data: merged,
                ...usageOnEvent,
              } as StreamEvent);
              if (refs.size === 0) {
                finalOutput = merged as unknown as Output;
              } else {
                const finalMerged: Record<string, unknown> = { ...merged };
                for (const [port, ref] of refs) finalMerged[port] = ref;
                finalOutput = finalMerged as unknown as Output;
              }
            } else {
              // No accumulation. For replace-mode streams the provider's finish
              // event carries `data: {}` by convention — the snapshots already
              // delivered the value, so the finish payload is intentionally
              // empty. Fall back to `runOutputData` (set on every snapshot above)
              // so we don't clobber the last snapshot with an empty object. This
              // mirrors the same fallback in the accumulation branch.
              const finishData = (event.data ?? {}) as Record<string, unknown>;
              if (streamMode === "replace" && Object.keys(finishData).length === 0) {
                const lastSnapshot = this.task.runOutputData;
                if (lastSnapshot && Object.keys(lastSnapshot).length > 0) {
                  finalOutput = lastSnapshot as Output;
                  this.task.emit("stream_chunk", {
                    type: "finish",
                    data: lastSnapshot,
                    ...usageOnEvent,
                  } as StreamEvent);
                  break;
                }
                // A refusal-terminated stream legitimately carries no value:
                // fall through so the run COMPLETES and the post-loop fold
                // surfaces the refusal on `output.refusal`.
                if (refusalText.length === 0) throw this.replaceModeNoValueError();
              }
              finalOutput = event.data as Output;
              this.task.emit("stream_chunk", event as StreamEvent);
            }
            break;
          }
          case "refusal": {
            // A refusal is a valid outcome, not an error: flip to STREAMING like a
            // data event, accumulate the text, and surface it via the reserved
            // `refusal` output field after the stream ends. The task still
            // COMPLETES; consumers detect it by checking `output.refusal`.
            if (!streamingStarted) {
              streamingStarted = true;
              this.task.status = TaskStatus.STREAMING;
              this.task.emit("status", this.task.status);
            }
            refusalText += event.refusal;
            if (event.category) refusalCategory = event.category;
            this.task.emit("stream_chunk", event as StreamEvent);
            break;
          }
          case "error": {
            throw event.error;
          }
        }
      }
    } catch (err) {
      // Surface the error to any in-flight router sinks so they reject
      // (rather than waiting forever on the producer). The original error is
      // rethrown unchanged.
      const failure = err instanceof Error ? err : new Error(String(err));
      for (const { router } of routers.values()) router.fail(failure);
      throw err;
    } finally {
      // An aborted or errored stream still spent the input tokens it sent, so
      // a *stated* snapshot is promoted rather than dropped. A character-count
      // estimate is not a record of what was spent, and an interrupted stream
      // is where it is least trustworthy.
      if (liveUsage) {
        const dropped = liveUsage.estimated === true;
        if (!dropped) settledUsage = mergeUsage(settledUsage, liveUsage);
        liveUsage = undefined;
        // Withdraw the estimate from `runUsage` too, so it does not survive as
        // this execution's reported total. Only on the drop, so the stated path
        // emits exactly what it emitted before.
        if (dropped) publishRunning();
      }
      // If the loop exited without a `finish` event (abort via cooperative
      // generator return, or a generator ending early), the routed bytes are
      // incomplete: FAIL the routers so their sinks reject and discard the
      // partial write, instead of committing a truncated blob to the cache as
      // a finished artifact. After a normal finish, `end()` is an idempotent
      // no-op (the finish handler already ended the routers).
      if (sawFinish) {
        for (const { router } of routers.values()) router.end();
      } else {
        const incomplete = new TaskError(
          `Task ${this.task.type} stream ended without a finish event; discarding partial output.`
        );
        for (const { router } of routers.values()) router.fail(incomplete);
      }
    }

    // Check if the task was aborted during streaming
    if (ctx.abortController.signal.aborted) {
      throw new TaskAbortedError("Task aborted during streaming");
    }

    if (finalOutput !== undefined) {
      this.task.runOutputData = finalOutput;
    }

    // Fold an accumulated refusal into the final output's reserved field so
    // programmatic consumers (run() result, collectStream, agent loops) can
    // detect it. Kept off streamed data edges (Dataflow treats refusal as
    // metadata, like phase).
    if (refusalText.length > 0) {
      this.task.runOutputData = {
        ...(this.task.runOutputData as Record<string, unknown> | undefined),
        [REFUSAL_OUTPUT_KEY]: refusalText,
        ...(refusalCategory ? { [REFUSAL_CATEGORY_OUTPUT_KEY]: refusalCategory } : {}),
      } as unknown as Output;
    }

    // Same treatment for token accounting: a reserved output field, kept off
    // dataflow edges, applied after any refusal so a refused turn still reports
    // what it was billed. Absent when no provider reported usage.
    if (settledUsage) {
      this.task.runOutputData = {
        ...(this.task.runOutputData as Record<string, unknown> | undefined),
        [USAGE_OUTPUT_KEY]: settledUsage,
      } as unknown as Output;
    }

    this.task.emit("stream_end", this.task.runOutputData as Output);

    return this.task.runOutputData as Output;
  }
}

/**
 * Producer-consumer router used by {@link StreamProcessor} to forward a single
 * binary output port's `binary-delta` chunks to a {@link BinaryRefSink}. The
 * sink consumes the chunks via the async iterable and returns a
 * {@link CacheRef} that the processor places into `Output` at finish.
 *
 * Lifecycle: chunks pushed via `push()` are yielded to the sink in order.
 * `end()` signals end-of-stream (sink completes consumption, refPromise
 * resolves). `fail(err)` causes the iterable to throw on the next read
 * (refPromise rejects). `end()` and `fail()` are idempotent.
 *
 * Backpressure: byte-bounded. `push()` returns a Promise; the producer is
 * resolved immediately while the buffered (un-consumed) byte total stays
 * below `highWaterMarkBytes`, and parks until the consumer drains the
 * buffer back under the mark once the threshold is reached. `end()` and
 * `fail()` BOTH release any parked producer so an abort mid-park does not
 * leak the `push()` promise.
 */
export class BinaryStreamRouter {
  private readonly buffer: Uint8Array[] = [];
  /** Resolver for the consumer side (iterable awaiting next chunk). */
  private chunkNotify: (() => void) | undefined;
  private readonly refPromise: Promise<CacheRef>;
  /** Byte-bounded backpressure accounting + producer park/wake. */
  private readonly gate: BackpressureGate;

  constructor(sink: BinaryRefSink, highWaterMarkBytes: number) {
    this.gate = new BackpressureGate(highWaterMarkBytes);
    this.refPromise = sink(this.iterable());
    // A sink that dies mid-consumption (throws out of its for-await) settles
    // refPromise while the producer may still be pushing — or parked at the
    // high-water mark with nothing left to drain the buffer. fail() wakes a
    // parked producer with the rejection and records the failure so later
    // pushes reject, instead of the run wedging on a dead sink. This handler
    // also observes the rejection, so an unawaited refPromise never surfaces
    // as an unhandled rejection; a subsequent `await this.refPromise` still
    // rejects.
    this.refPromise.catch((err) => {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Buffer one chunk and return a Promise the caller must await. The promise
   * resolves immediately when buffered bytes remain under the high-water
   * mark, and otherwise parks until the consumer drains the buffer (or until
   * `end()` / `fail()` releases all parked callers).
   */
  push(chunk: Uint8Array): Promise<void> {
    // A recorded failure (sink death, upstream fail()) must surface to the
    // producer: post-failure deltas reject so the processor fails the task
    // with the sink error instead of silently dropping bytes.
    if (this.gate.failure) return Promise.reject(this.gate.failure);
    if (this.gate.closed) return Promise.resolve();
    this.buffer.push(chunk);
    // Between the fast-path check above and here, another turn may have called
    // `end()` / `fail()`. If so, un-stage the chunk so it never surfaces to the
    // consumer and return without waking or charging the gate — the sink has
    // already been told the stream ended.
    if (this.gate.closed) {
      this.buffer.pop();
      return Promise.resolve();
    }
    this.wakeChunk();
    return this.gate.charge(chunk.byteLength);
  }

  end(): void {
    // close() releases any producer parked at the high-water mark — abort
    // mid-stream would otherwise orphan the parked Promise. wakeChunk lets the
    // consumer iterable observe the close and return.
    this.gate.close();
    this.wakeChunk();
  }

  fail(err: Error): void {
    this.gate.fail(err);
    this.wakeChunk();
  }

  ref(): Promise<CacheRef> {
    return this.refPromise;
  }

  /** @internal Test hook: current buffered byte count (consumer-unread). */
  public get _bufferedBytes(): number {
    return this.gate._bufferedCost;
  }

  /** @internal Test hook: high-water mark in effect. */
  public get _highWaterMarkBytes(): number {
    return this.gate._highWaterMark;
  }

  /**
   * @internal Used by {@link IExecuteContext.backpressure} so a task
   * emitting via a side channel can park until the consumer drains. Resolves
   * immediately when the buffer is already under the mark or the router has
   * been closed.
   */
  public _awaitDrain(): Promise<void> {
    return this.gate.awaitBelowMark();
  }

  private wakeChunk(): void {
    const n = this.chunkNotify;
    this.chunkNotify = undefined;
    n?.();
  }

  private async *iterable(): AsyncIterable<Uint8Array> {
    while (true) {
      // Failure takes priority over buffered chunks so a `fail()` mid-stream
      // surfaces to the sink before any already-buffered payload — a consumer
      // that saw the chunk first would treat a partial payload as complete.
      if (this.gate.failure) throw this.gate.failure;
      while (this.buffer.length > 0) {
        const chunk = this.buffer.shift()!;
        // Credit the gate as we hand the chunk to the sink; this wakes any
        // producer parked at the high-water mark once we drop below it. We
        // resolve as soon as we cross the threshold rather than waiting for the
        // buffer to drain fully — that keeps the producer pipelined.
        this.gate.credit(chunk.byteLength);
        yield chunk;
      }
      if (this.gate.failure) throw this.gate.failure;
      if (this.gate.closed) return;
      await new Promise<void>((res) => {
        this.chunkNotify = res;
      });
    }
  }
}
