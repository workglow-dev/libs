/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema, JsonSchema } from "@workglow/util/schema";

/**
 * Stream mode determines how a task's streaming output is interpreted:
 * - `none`: No streaming (default). `execute()` returns `Promise<Output>`.
 * - `append`: Each chunk is a delta (e.g., a new token).
 * - `replace`: Each chunk is a corrected/revised snapshot of the complete output so far.
 * - `object`: Each chunk is a progressively more complete partial object snapshot.
 * - `binary`: Each chunk is an ordered byte slice; consumer concatenates into a Blob/ArrayBuffer.
 * - `mixed`: Multiple ports use different stream modes (e.g., append + object).
 *
 * Declared per-port via the `x-stream` schema extension property.
 * Absent `x-stream` = `"none"`.
 */
export type StreamMode = "none" | "append" | "replace" | "object" | "binary" | "mixed";

/**
 * Append mode: delta chunk (consumer accumulates).
 * `port` identifies which output port this delta belongs to.
 */
export type StreamTextDelta = {
  type: "text-delta";
  port: string;
  textDelta: string;
};

/**
 * Object delta for structured/object streaming.
 * `port` identifies which output port this delta belongs to.
 *
 * - **Non-array** (e.g. structured generation): each `objectDelta` is a
 *   progressively more complete partial object snapshot. Consumers should
 *   replace (not merge) their state with the latest delta.
 * - **Array** (e.g. tool calls): each `objectDelta` is a single-element
 *   array containing one item to upsert by `id` into the accumulated array.
 */
export type StreamObjectDelta = {
  type: "object-delta";
  port: string;
  objectDelta: Record<string, unknown> | unknown[];
};

/**
 * Binary mode: an ordered, append-only chunk of bytes (consumer concatenates).
 * `port` identifies which output port this delta belongs to. Chunks are
 * materialized on `finish` into a `Blob` or `ArrayBuffer` per the port's
 * schema `format` (see `materializeBinary`).
 */
export type StreamBinaryDelta = {
  type: "binary-delta";
  port: string;
  binaryDelta: Uint8Array;
};

/**
 * Replace mode: full snapshot chunk (replaces previous state).
 */
export type StreamSnapshot<Output = Record<string, any>> = {
  type: "snapshot";
  data: Output;
};

/**
 * Provider-agnostic token accounting for one model request.
 *
 * Every field is `number | undefined`, and `undefined` means **the provider did
 * not report this figure** — it is NOT the same as `0`. Cost math depends on the
 * distinction: a model that bills 0 cached tokens and a model that never tells
 * you about caching are different facts, and collapsing them to `0` silently
 * understates spend.
 *
 * **Field relationships.** Counters are disjoint where the provider bills them
 * at different rates; a counter sharing a rate with its parent is a labelled
 * subset of it.
 *
 * - `input` / `output` — prompt and completion tokens.
 * - `cached` — prompt tokens served from a provider-side cache (read).
 * - `cacheWrite` — prompt tokens written into that cache.
 * - `input`, `cached` and `cacheWrite` are **disjoint**: `input` is the portion
 *   billed at the base input rate and never includes cache reads or writes, so
 *   `input + cached + cacheWrite` is the full prompt. Providers reporting a
 *   grand total plus a breakdown line are normalized by subtraction.
 * - `reasoning` — output tokens spent on hidden reasoning, when reported
 *   separately. **`output` includes `reasoning`**: no provider charges a
 *   distinct reasoning rate, so it is a visibility breakdown of `output`, not a
 *   sibling of it. Providers reporting them disjointly are normalized by
 *   addition.
 * - `total` — the provider's own total, when it reports one. Never synthesized.
 *   When present it satisfies `input + cached + cacheWrite + output === total`.
 * - `extra` — provider-specific counters that have no normalized slot.
 *
 * **Subtract only what the provider stated.** When `cached` is unreported,
 * `input` remains the provider's stated prompt total and `cached` stays
 * `undefined`; the disjointness invariant holds vacuously under uncertainty
 * rather than being enforced by a guess.
 */
export interface Usage {
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly cached: number | undefined;
  readonly cacheWrite: number | undefined;
  readonly reasoning: number | undefined;
  readonly total: number | undefined;
  readonly extra: Readonly<Record<string, number | string>> | undefined;
  /**
   * Set when any contributing counter is a heuristic (character-count)
   * estimate rather than a provider-stated figure. Absent means stated. A
   * total mixing the two is an estimate.
   *
   * Deliberately `?: true` rather than the house `boolean | undefined` style.
   * A required key forces an edit at every `Usage` literal and breaks
   * out-of-tree constructors — which is exactly the change to a shape
   * consumers persist that this is meant to avoid. `false` is never written;
   * the absence of the key is the "stated" case.
   */
  readonly estimated?: true;
}

/**
 * Reserved output-port name that {@link Usage} is surfaced on. Not a declared
 * task port — kept out of dataflow like {@link REFUSAL_OUTPUT_KEY} and `__cv`.
 */
export const USAGE_OUTPUT_KEY = "usage";

/**
 * The token cost of replaying a cached task output: verifiably nothing.
 *
 * A *stated* zero, not an unknown — which is what distinguishes "this cost you
 * nothing because it was cached" from "no model ran here" (`undefined`). `extra`
 * stays unreported because a bag that may hold a model id or service tier has no
 * meaningful zero.
 */
export const CACHE_HIT_USAGE: Usage = {
  input: 0,
  output: 0,
  cached: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  extra: undefined,
};

/**
 * Signals that the stream has finished. In append mode, the runner
 * accumulates text-delta chunks into the append port (determined by
 * the output schema's `x-stream: "append"` annotation); `data` may
 * carry additional fields (merged into the final output).
 * In replace mode, `data` contains the final output.
 *
 * `usage` is a SIBLING of `data`, never a member of it: `data` is governed by
 * the streaming conventions (`{}` for delta streams, the full payload for
 * one-shot run-fns, the parsed object for json-mode), and folding token counts
 * into it would corrupt all three.
 */
export type StreamFinish<Output = Record<string, any>> = {
  type: "finish";
  data: Output;
  usage?: Usage;
};

/**
 * Signals that the stream encountered an error.
 */
export type StreamError = {
  type: "error";
  error: Error;
};

/**
 * Signals that the model refused to answer (a policy/safety decline). A refusal
 * is a *valid* outcome, distinct from `error` (nothing failed) and from ordinary
 * content (the caller wants to detect it): the task still COMPLETES, with the
 * refusal accumulated into the reserved `refusal` output field. `refusal` text
 * may stream in fragments (consumer concatenates); `category` is an optional,
 * provider-normalized reason (e.g. "output-refusal", "input-blocked").
 */
export type StreamRefusal = {
  type: "refusal";
  refusal: string;
  category?: string;
};

/**
 * Token accounting reported *while* a request is still streaming.
 *
 * `usage` is a **cumulative snapshot of the current model call**, not a delta —
 * every provider that reports mid-stream restates running totals, and cumulative
 * is what composes with the last-wins consumption in StreamProcessor. Consumers
 * replace their in-flight value with each snapshot and never merge them, or the
 * same tokens are counted once per event.
 *
 * A run-fn that emits these MUST still emit a `finish` whose `usage` is the
 * complete total for the call; `finish` supersedes the snapshots it summarizes.
 *
 * Metadata, not data: it never flips the task to STREAMING, is not accumulated
 * into dataflow, and never appears in a `finish` payload.
 */
export type StreamUsage = {
  type: "usage";
  usage: Usage;
};

/**
 * Reserved output-port name that refusal text is accumulated into. Not a
 * declared task port — kept out of dataflow like `__cv` (cache versioning).
 */
export const REFUSAL_OUTPUT_KEY = "refusal";
export const REFUSAL_CATEGORY_OUTPUT_KEY = "refusalCategory";

/**
 * Adds two optional counters while preserving "not reported". Two unreported
 * counters stay unreported; one reported counter survives a missing partner
 * unchanged (rather than being diluted by an implicit zero).
 */
function addUsageField(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function mergeUsageExtra(
  a: Readonly<Record<string, number | string>> | undefined,
  b: Readonly<Record<string, number | string>> | undefined
): Readonly<Record<string, number | string>> | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged: Record<string, number | string> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = merged[key];
    // Only counters compose. A string is a label (model id, service tier, cache
    // key), so the later turn's value replaces the earlier one.
    merged[key] =
      typeof existing === "number" && typeof value === "number" ? existing + value : value;
  }
  return merged;
}

/**
 * Combines the token accounting of two requests — a tool-calling loop's turns,
 * or a structured-generation task's validation retries — into one {@link Usage}.
 * Field-wise addition that preserves `undefined` (see {@link Usage}), so a
 * provider that reports nothing never fabricates zeros for the caller's cost math.
 *
 * The preservation is per-pair, not transitive: a counter one side states as `0`
 * and the other leaves unreported merges to `0`, because there is no third value
 * meaning "partly unknown". So in an aggregate a `0` means *at least one*
 * contributor stated `0` — not that every contributor did. A single cache hit is
 * enough to trigger it, since {@link CACHE_HIT_USAGE} states `0` on every
 * counter. Read per-execution rows, not the aggregate, when the distinction
 * between "billed nothing" and "never reported" has to survive.
 *
 * `estimated` is sticky in the other direction: one estimated contributor makes
 * the whole total an estimate, since no counter here records which side it came
 * from.
 */
export function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: addUsageField(a.input, b.input),
    output: addUsageField(a.output, b.output),
    cached: addUsageField(a.cached, b.cached),
    cacheWrite: addUsageField(a.cacheWrite, b.cacheWrite),
    reasoning: addUsageField(a.reasoning, b.reasoning),
    total: addUsageField(a.total, b.total),
    extra: mergeUsageExtra(a.extra, b.extra),
    // Spread conditionally so a stated total carries no key at all, rather
    // than an explicit `estimated: undefined`.
    ...(a.estimated || b.estimated ? { estimated: true as const } : {}),
  };
}

/**
 * Phase / status event yielded by a streaming source to signal a named
 * phase transition (e.g. "Preparing", "Generating", "Tool: search").
 *
 * Carries an optional `progress` percentage for phases where progress
 * is measurable (e.g. "Loading model" with fractional percent), or
 * absent for indeterminate phases.
 *
 * Phase events are metadata, not data:
 *  - They are emitted on `stream_chunk` for observability.
 *  - They are NOT accumulated into dataflow edges.
 *  - They are NOT included in the `finish` payload.
 *  - The TaskRunner translates each phase event into a single
 *    `progress` event with the phase's `progress` and `message`.
 *  - They do NOT flip the task status to STREAMING; only data events
 *    (`text-delta` / `object-delta` / `snapshot`) do.
 */
export type StreamPhase = {
  type: "phase";
  message: string;
  progress: number | undefined;
};

/**
 * How far one tool call a task is running on a model's behalf has got.
 *
 * Emitted per call, so a host drawing a card for one has the card's whole
 * life on the wire. Without it the only account of a tool call is the
 * conversation the task publishes, and a card has to be reconstructed by
 * diffing successive copies of that: the ask appears when the assistant
 * message lands, and the outcome when the results land — as one batch, after
 * the last of them, with nothing in between and no way to tell which call is
 * running now. A host owning its own tools can fill that in from inside them,
 * which is why this was not missed earlier; a host whose tools are task types
 * it named cannot, and neither can one relaying to a protocol.
 *
 * Metadata, not data, on the same terms as {@link StreamPhase}: emitted on
 * `stream_chunk`, never accumulated into a port, never part of a `finish`
 * payload, and no status flip. A task that reports these still reports its
 * conversation — this says where a call has got to, not what was said.
 *
 * `status` discriminates what else is known, rather than every field being
 * optional on one shape:
 *  - `pending` — the model asked for it; nothing has run. Carries `input`.
 *  - `running` — the task has taken the call up. Every call passes through
 *    this, including the ones nothing ever executes for: a tool that does not
 *    exist, arguments its schema rejects, a call nobody approves. A host then
 *    draws one lifecycle rather than one per way a call can go, and `running`
 *    covers waiting on a person for the same reason — an approval is part of
 *    making the call, and a host drawing its own approval knows it asked.
 *  - `completed` / `failed` — settled, carrying the text the model reads
 *    back. `failed` is the call's own outcome — it threw, its arguments were
 *    rejected, nobody approved it — and not an error that ends the run.
 */
export type StreamToolCall =
  | {
      type: "tool-call";
      status: "pending";
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-call";
      status: "running";
      toolCallId: string;
      name: string;
    }
  | {
      type: "tool-call";
      status: "completed" | "failed";
      toolCallId: string;
      name: string;
      /** What the model reads back, after the same clamp the result carries. */
      result: string;
    };

/**
 * Discriminated union of all stream event types.
 * Used as the element type for `AsyncIterable<StreamEvent>` streams
 * flowing through the DAG.
 */
export type StreamEvent<Output = Record<string, any>> =
  | StreamTextDelta
  | StreamObjectDelta
  | StreamBinaryDelta
  | StreamSnapshot<Output>
  | StreamFinish<Output>
  | StreamError
  | StreamRefusal
  | StreamUsage
  | StreamPhase
  | StreamToolCall;

// ========================================================================
// Port-level stream helpers
// ========================================================================

/**
 * Reads the `x-stream` value from a specific port property in a DataPortSchema.
 * Returns `"none"` when the property or the `x-stream` annotation is absent.
 *
 * @param schema - The task's input or output DataPortSchema
 * @param portId - The property name (port ID) to inspect
 * @returns The StreamMode declared on that port
 */
export function getPortStreamMode(schema: DataPortSchema | JsonSchema, portId: string): StreamMode {
  if (typeof schema === "boolean") return "none";
  const prop = (schema.properties as Record<string, any>)?.[portId];
  if (!prop || typeof prop === "boolean") return "none";
  const xStream = prop["x-stream"];
  if (xStream === "append" || xStream === "replace" || xStream === "object" || xStream === "binary")
    return xStream;
  return "none";
}

/**
 * Returns all ports that declare an `x-stream` annotation, along with their mode.
 *
 * @param schema - The task's output (or input) DataPortSchema
 * @returns Array of `{ port, mode }` for every annotated port
 */
export function getStreamingPorts(
  schema: DataPortSchema
): Array<{ port: string; mode: StreamMode }> {
  if (typeof schema === "boolean") return [];
  const props = schema.properties;
  if (!props) return [];

  const result: Array<{ port: string; mode: StreamMode }> = [];
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop === "boolean") continue;
    const xStream = (prop as any)["x-stream"];
    if (
      xStream === "append" ||
      xStream === "replace" ||
      xStream === "object" ||
      xStream === "binary"
    ) {
      result.push({ port: name, mode: xStream });
    }
  }
  return result;
}

/**
 * Delta stream modes: the modes whose events are incremental per-port deltas
 * that can be encoded to (and replayed from) a single-port byte stream via
 * {@link getStreamPortCodec}. `replace` (snapshot-driven), `none`, and `mixed`
 * are not delta modes.
 */
export function isDeltaStreamMode(
  mode: StreamMode
): mode is Extract<StreamMode, "append" | "object" | "binary"> {
  return mode === "append" || mode === "object" || mode === "binary";
}

/**
 * True when `schema` declares at least one streaming output port and EVERY one
 * of them is `binary` — the port shape whose deltas can go straight to a cache
 * sink with no in-memory accumulator behind them.
 *
 * The binary-only half is what makes it safe, and it is not a simplification:
 * only binary ports get sinks on the unflagged path, so an `append`/`object`
 * port sitting alongside them would end up with neither a sink nor (with
 * accumulation skipped) an accumulator, and its deltas would be dropped in
 * silence. The count is free — each binary port gets its own sink and its own
 * {@link CacheRef}.
 *
 * Shared by the two places that make that call — the graph's
 * `StreamPump.canStreamBinaryToCache` and `TaskRunner`'s standalone-run
 * relaxation — so the two cannot answer the port-shape question differently.
 * Each still adds the gate the other cannot see: consumer analysis for the
 * graph, "no caller stated a preference" for the standalone run.
 */
export function allStreamingPortsAreBinary(schema: DataPortSchema): boolean {
  const ports = getStreamingPorts(schema);
  return ports.length > 0 && ports.every((p) => p.mode === "binary");
}

/**
 * Reads the per-port `x-validate-stream` opt-in from an input schema: a port
 * that sets it wants its stream materialized and validated as a whole value,
 * opting out of both the validation exemption for stream-wired ports and the
 * no-accumulation passthrough for its edge.
 */
export function portForcesStreamValidation(
  schema: DataPortSchema | JsonSchema,
  port: string
): boolean {
  if (typeof schema === "boolean") return false;
  const prop = (schema.properties as Record<string, any>)?.[port];
  if (!prop || typeof prop === "boolean") return false;
  return prop["x-validate-stream"] === true;
}

/**
 * Returns the dominant output stream mode for a task by inspecting its output schema.
 * Returns `"mixed"` when ports use different modes (e.g., append + object).
 * Returns `"none"` if no output port declares streaming.
 */
export function getOutputStreamMode(outputSchema: DataPortSchema): StreamMode {
  const ports = getStreamingPorts(outputSchema);
  if (ports.length === 0) return "none";

  const mode = ports[0].mode;
  for (let i = 1; i < ports.length; i++) {
    if (ports[i].mode !== mode) {
      return "mixed";
    }
  }
  return mode;
}

/**
 * Determines whether a task supports streaming by checking if any output port
 * has an `x-stream` annotation AND the task implements `executeStream()`.
 *
 * @param task - The task to inspect (must have `outputSchema()` and optionally `executeStream`)
 * @returns true if the task can produce streaming output
 */
export function isTaskStreamable(task: {
  outputSchema(): DataPortSchema;
  executeStream?: (...args: any[]) => any;
}): boolean {
  if (typeof task.executeStream !== "function") return false;
  return getOutputStreamMode(task.outputSchema()) !== "none";
}

/**
 * Determines whether a task CONSUMES a stream: it implements `executeStream()`
 * and declares a delta-mode (`append` / `object` / `binary`) port on its INPUT
 * schema.
 *
 * Distinct from {@link isTaskStreamable}, which asks whether a task PRODUCES
 * one. A pure sink — reads a stream, returns a small summary — produces no
 * stream and would otherwise be handed a fully drained input, which is the
 * whole cost the stream was avoiding.
 */
export function isStreamConsumer(task: {
  inputSchema(): DataPortSchema;
  executeStream?: (...args: any[]) => any;
}): boolean {
  if (typeof task.executeStream !== "function") return false;
  return getStreamingPorts(task.inputSchema()).some((p) => isDeltaStreamMode(p.mode));
}

/**
 * Returns the port ID (property name) of the first output port that declares
 * `x-stream: "append"`, or `undefined` if no such port exists.
 *
 * @param schema - The task's output DataPortSchema
 * @returns The port name with append streaming, or undefined
 */
export function getAppendPortId(schema: DataPortSchema): string | undefined {
  if (typeof schema === "boolean") return undefined;
  const props = schema.properties;
  if (!props) return undefined;

  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop === "boolean") continue;
    if ((prop as any)["x-stream"] === "append") return name;
  }
  return undefined;
}

/**
 * Determines whether a dataflow edge needs to accumulate stream events
 * into a materialized value for the target port.
 *
 * Accumulation is needed when:
 * - The source output port declares streaming (`x-stream` is set)
 * - AND the target input port does NOT accept the same stream mode
 *
 * @param sourceSchema - Output schema of the source task
 * @param sourcePort - Port ID on the source task
 * @param targetSchema - Input schema of the target task
 * @param targetPort - Port ID on the target task
 * @returns true if the edge should accumulate; false if stream can pass through
 */
export function edgeNeedsAccumulation(
  sourceSchema: DataPortSchema,
  sourcePort: string,
  targetSchema: DataPortSchema,
  targetPort: string
): boolean {
  const sourceMode = getPortStreamMode(sourceSchema, sourcePort);
  if (sourceMode === "none") return false;
  const targetMode = getPortStreamMode(targetSchema, targetPort);
  return sourceMode !== targetMode;
}

/**
 * Returns the port ID (property name) of the first output port that declares
 * `x-stream: "object"`, or `undefined` if no such port exists.
 *
 * @param schema - The task's output DataPortSchema
 * @returns The port name with object streaming, or undefined
 */
export function getObjectPortId(schema: DataPortSchema): string | undefined {
  if (typeof schema === "boolean") return undefined;
  const props = schema.properties;
  if (!props) return undefined;

  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop === "boolean") continue;
    if ((prop as any)["x-stream"] === "object") return name;
  }
  return undefined;
}

/**
 * Canonical vocabulary for the `format` annotation on a binary streaming output
 * port. `"blob"` materializes chunks into a `Blob` (the default); `"binary"`
 * materializes them into an `ArrayBuffer`. Any other value is rejected at
 * registration time (see {@link assertBinaryFormat}) so a typo like `"Blob"`
 * cannot silently fall through to the ArrayBuffer branch.
 */
export type BinaryFormat = "blob" | "binary";

/**
 * Default high-water mark for the binary-stream router's producer buffer, in
 * bytes. When the buffered (un-consumed) byte total reaches this threshold the
 * producer awaits a drain signal from the consumer before pushing further
 * chunks; below the threshold the producer is allowed to run free. 8 MiB lets
 * even fast producers race ahead by a few chunks without stalling, while
 * bounding worst-case memory growth when the sink (cache, disk, network)
 * cannot keep up. Callers can override per-run via
 * `IRunConfig.streamHighWaterBytes`.
 */
export const DEFAULT_BINARY_HIGH_WATER_BYTES = 8 * 1024 * 1024;

/**
 * Default watchdog timeout (milliseconds) for the no-accumulation passthrough
 * gate: if a producer parks at the high-water mark and neither pull nor credit
 * progresses within this window, the gate fails so the producer's `push()`
 * rejects rather than hanging the run. 60 s is long enough to survive a normal
 * consumer stall (GC pause, disk fsync spike) while short enough that a truly
 * dead consumer surfaces as a run-level error instead of a wedged process.
 * Callers can override per-run via `IRunConfig.streamGateWatchdogMs`; pass `0`
 * to disable the watchdog entirely.
 */
export const DEFAULT_STREAM_GATE_WATCHDOG_MS = 60_000;

/**
 * Buffered cost of a single stream event, in approximate bytes, for
 * backpressure accounting. Delta events cost their payload size (UTF-16 code
 * units for `text-delta` — a cheap approximation of bytes that avoids a UTF-8
 * encode per delta on the hot path, JSON-encoded length for `object-delta`,
 * raw byte length for `binary-delta`); control events (`finish`, `snapshot`,
 * `phase`, `error`) cost nothing — they are not what a slow consumer buffers
 * up on. The gate is approximate accounting, and this function is
 * deterministic per event, so charge and credit sites can each compute it
 * independently and always agree.
 */
export function streamEventCost(event: StreamEvent): number {
  switch (event.type) {
    case "text-delta":
      return event.textDelta.length;
    case "object-delta":
      return JSON.stringify(event.objectDelta).length;
    case "binary-delta":
      return event.binaryDelta.byteLength;
    default:
      return 0;
  }
}

/**
 * Reads the `format` annotation of a single output port from the task's output
 * schema. Returns the raw string (or `undefined`) — callers needing the
 * canonical {@link BinaryFormat} vocabulary should go through
 * {@link assertBinaryFormat}, which rejects unknown values.
 */
export function getBinaryPortFormat(schema: DataPortSchema, port: string): string | undefined {
  if (typeof schema === "boolean") return undefined;
  const prop = (schema.properties as Record<string, any>)?.[port];
  if (!prop || typeof prop === "boolean") return undefined;
  return prop.format as string | undefined;
}

/**
 * Resolves the `format` annotation on a binary streaming port to a canonical
 * {@link BinaryFormat}. `undefined` and `"blob"` both resolve to `"blob"`;
 * `"binary"` resolves to `"binary"`. Anything else throws — a casing typo such
 * as `"Blob"` or a leftover legacy value would otherwise be silently coerced
 * to one branch and produce the wrong runtime type, so this is checked at
 * task-registration time and again on the streaming hot paths.
 */
export function assertBinaryFormat(schema: DataPortSchema, port: string): BinaryFormat {
  const f = getBinaryPortFormat(schema, port);
  if (f === undefined || f === "blob") return "blob";
  if (f === "binary") return "binary";
  throw new Error(
    `Port "${port}" has x-stream:"binary" but format:"${f}". Allowed: "blob" | "binary".`
  );
}

/**
 * Materializes ordered binary chunks into the value type declared by the
 * output port's canonical {@link BinaryFormat}:
 *  - `"blob"`   → `Blob` (the default)
 *  - `"binary"` → `ArrayBuffer`
 *
 * Chunks are concatenated in arrival order. Callers MUST pass chunks in the
 * order they were emitted, and MUST resolve `format` through
 * {@link assertBinaryFormat} so unknown values are rejected at registration
 * rather than reinterpreted here.
 *
 * @param chunks - Ordered binary chunks to concatenate
 * @param format - Canonical binary format selector
 * @returns The materialized `Blob` or `ArrayBuffer`
 */
export function materializeBinary(
  chunks: readonly Uint8Array[],
  format: BinaryFormat
): Blob | ArrayBuffer {
  if (format === "blob") return new Blob(chunks as unknown as BlobPart[]);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged.buffer;
}

/**
 * Folds one `object-delta` into the running accumulated value, matching the
 * live accumulator semantics:
 *  - **Array** delta: upsert each item by its `id` into the accumulated array
 *    (replace an existing entry with the same `id`, otherwise append). Items
 *    without an `id` are appended.
 *  - **Non-array** delta (e.g. structured generation): replace the accumulated
 *    value entirely with the latest snapshot.
 *
 * Shared by the live streaming accumulator and the object stream codec so a
 * replayed/materialized cache value folds identically to a fresh run.
 */
export function foldObjectDelta(
  existing: Record<string, unknown> | unknown[] | undefined,
  delta: Record<string, unknown> | unknown[]
): Record<string, unknown> | unknown[] {
  if (Array.isArray(delta)) {
    const arr: unknown[] = Array.isArray(existing) ? [...existing] : [];
    for (const item of delta) {
      const itemObj = item as Record<string, unknown>;
      if (itemObj && typeof itemObj === "object" && "id" in itemObj) {
        const idx = arr.findIndex((e) => (e as Record<string, unknown>).id === itemObj.id);
        if (idx >= 0) arr[idx] = item;
        else arr.push(item);
      } else {
        arr.push(item);
      }
    }
    return arr;
  }
  return delta;
}

/**
 * Returns a map of port names to their JSON Schemas for every output port
 * that declares `"x-structured-output": true`.
 *
 * @param schema - The task's output DataPortSchema
 * @returns Map of port-name → JSON Schema for structured output ports
 */
export function getStructuredOutputSchemas(schema: DataPortSchema): Map<string, JsonSchema> {
  const result = new Map<string, JsonSchema>();
  if (typeof schema === "boolean") return result;
  const props = schema.properties;
  if (!props) return result;

  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop === "boolean") continue;
    if ((prop as any)["x-structured-output"] === true) {
      result.set(name, prop as JsonSchema);
    }
  }
  return result;
}

/**
 * Returns true if the schema has any output port with `"x-structured-output": true`.
 */
export function hasStructuredOutput(schema: DataPortSchema): boolean {
  return getStructuredOutputSchemas(schema).size > 0;
}
