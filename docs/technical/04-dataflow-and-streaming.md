<!--
  @license
  Copyright 2025 Steven Roussey <sroussey@gmail.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Dataflow and Streaming

## Overview

The Workglow task graph engine connects tasks through **dataflow edges** that carry typed data between output and input ports. While the DAG structure defines the dependency order, dataflows define the data contracts -- which output port feeds which input port, how values are propagated, and whether data flows as a complete materialized value or as a stream of incremental events.

This document covers two interconnected systems:

1. **Dataflow** -- the edge abstraction that connects task ports, carries values, and manages lifecycle status.
2. **Streaming** -- the system for incremental output delivery, including stream modes, stream events, the `x-stream` schema annotation, and delta accumulation.

Together, these systems enable everything from simple port-to-port value passing to real-time token-by-token streaming of AI model output through a multi-task pipeline.

---

## The Dataflow Class

### Identity and Structure

A `Dataflow` represents a single directed edge from one task's output port to another task's input port. It is defined by four identifiers:

```typescript
const dataflow = new Dataflow(
  sourceTaskId, // ID of the source task
  sourceTaskPortId, // Name of the output port on the source task
  targetTaskId, // ID of the target task
  targetTaskPortId // Name of the input port on the target task
);
```

The dataflow's `id` is a deterministic string derived from these four components:

```
sourceTaskId[sourceTaskPortId] ==> targetTaskId[targetTaskPortId]
```

For example: `"task-abc[result] ==> task-def[value]"`.

### State Management

Each dataflow maintains its own lifecycle state, mirroring the task lifecycle:

| Property | Type                          | Description                                   |
| -------- | ----------------------------- | --------------------------------------------- |
| `value`  | `any`                         | The materialized data carried by the dataflow |
| `status` | `TaskStatus`                  | Current lifecycle status                      |
| `error`  | `TaskError`                   | Error object if the dataflow failed           |
| `stream` | `ReadableStream<StreamEvent>` | Active stream for streaming tasks             |

The dataflow status transitions mirror the source task's execution:

```
PENDING --> PROCESSING --> STREAMING --> COMPLETED
                            |
                            +--> FAILED
```

### Value Propagation

When the TaskGraphRunner pushes output from a completed task onto outgoing dataflows, it calls `setPortData(entireDataBlock)`:

```typescript
// If sourceTaskPortId is a specific port name:
dataflow.value = entireDataBlock[sourceTaskPortId];

// If sourceTaskPortId is "*" (DATAFLOW_ALL_PORTS):
dataflow.value = entireDataBlock; // Entire output object

// If sourceTaskPortId is "[error]" (DATAFLOW_ERROR_PORT):
dataflow.error = entireDataBlock;
```

When the runner copies input from dataflows into a target task, it calls `getPortData()`:

```typescript
// If targetTaskPortId is a specific port name:
return { [targetTaskPortId]: dataflow.value };

// If targetTaskPortId is "*" (DATAFLOW_ALL_PORTS):
return dataflow.value; // Entire value object

// If targetTaskPortId is "[error]" (DATAFLOW_ERROR_PORT):
return { "[error]": dataflow.error };
```

### Special Port Identifiers

| Constant              | Value       | Description                                            |
| --------------------- | ----------- | ------------------------------------------------------ |
| `DATAFLOW_ALL_PORTS`  | `"*"`       | Pass the entire output/input object, not a single port |
| `DATAFLOW_ERROR_PORT` | `"[error]"` | Route error objects between tasks for error handling   |

The wildcard port `"*"` is used when a task should receive the complete output object from its upstream dependency, rather than a single named property.

### Semantic Compatibility

Dataflows validate that source and target ports are semantically compatible by inspecting their JSON Schema types:

```typescript
dataflow.semanticallyCompatible(graph, dataflow);
// Returns: "static" | "runtime" | "incompatible"
```

| Result           | Meaning                                         |
| ---------------- | ----------------------------------------------- |
| `"static"`       | Types are statically compatible                 |
| `"runtime"`      | Compatibility can only be determined at runtime |
| `"incompatible"` | Types are known to be incompatible              |

Compatibility results are cached for tasks with stable schemas. Tasks with `hasDynamicSchemas = true` bypass the cache because their schemas may change between checks.

### Reset

Calling `dataflow.reset()` returns the dataflow to its initial state:

```typescript
dataflow.reset();
// value = undefined
// status = PENDING
// error = undefined
// stream = undefined
// compatibility cache cleared
```

---

## The Port System

### Port Definition via JSON Schema

Task input and output ports are defined by the `properties` of the JSON Schema returned by `inputSchema()` and `outputSchema()`. Each property name is a port identifier, and the property's schema defines the port's type contract.

```typescript
static outputSchema(): DataPortSchema {
  return {
    type: "object",
    properties: {
      text: { type: "string", title: "Generated Text" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  } as const satisfies DataPortSchema;
}
```

This task has two output ports: `text` (string) and `confidence` (number).

### Schema Annotations

Ports support several custom annotations beyond standard JSON Schema:

| Annotation            | Type      | Description                                                                   |
| --------------------- | --------- | ----------------------------------------------------------------------------- |
| `x-stream`            | `string`  | Streaming mode: `"append"`, `"replace"`, or `"object"`                        |
| `x-ui-hidden`         | `boolean` | Hide from UI display                                                          |
| `x-ui-iteration`      | `boolean` | Iteration context port (hidden from parent display)                           |
| `x-ui-manual`         | `boolean` | User-added port (dynamic)                                                     |
| `x-auto-generated`    | `boolean` | Auto-generated primary key                                                    |
| `x-structured-output` | `boolean` | Port schema used for structured AI output                                     |
| `format`              | `string`  | Semantic type hint (e.g., `"model"`, `"storage:tabular"`, `"knowledge-base"`) |

---

## Streaming Primitive Contract

Workglow's streaming layer uses three primitives that serve distinct, non-overlapping roles. Authors only ever write one of them. The other two are engine internals.

### The Three Primitives

| Primitive                     | Role                | Where it appears                                       | Who writes it                     |
| ----------------------------- | ------------------- | ------------------------------------------------------ | --------------------------------- |
| `AsyncIterable<StreamEvent>`  | Authoring           | `Task.executeStream()`, `AiProviderStreamFn`           | Task / provider authors           |
| `ReadableStream<StreamEvent>` | Engine-internal tee | `Dataflow.stream`, `TaskGraphRunner` fan-out           | Engine only (do not use in tasks) |
| `EventEmitter` (task events)  | Observation only    | `stream_start`, `stream_chunk`, `stream_end` on `Task` | Engine emits; consumers subscribe |

### Authoring Rule: AsyncIterable

**All streaming tasks and providers MUST return `AsyncIterable<StreamEvent>` -- typically as an `async function*` generator.**

```typescript
// Task: use `async *executeStream()`
async *executeStream(input, context): AsyncIterable<StreamEvent> {
  yield { type: "text-delta", port: "text", textDelta: "Hello" };
  yield { type: "finish", data: {} as Output };
}

// Provider: the `AiProviderStreamFn` signature IS an AsyncIterable-returning function
export const MyProvider_Stream: AiProviderStreamFn = async function* (input, model, signal) {
  for await (const delta of underlyingSdk.stream(input, { signal })) {
    yield { type: "text-delta", port: "text", textDelta: delta };
  }
  yield { type: "finish", data: {} };
};
```

Why AsyncIterable for authoring:

- **Pull-based backpressure is inherent.** When the consumer is slow, `yield` suspends the generator. No buffer bloat without writing any extra code.
- **Cancel cleanup is natural.** A `try { ... } finally { ... }` in the generator runs when the consumer stops iterating -- including on `AbortSignal` firing.
- **Trivial to write.** One `async function*`; no manual controller plumbing.

### Engine-Internal: ReadableStream

`ReadableStream<StreamEvent>` exists in exactly two engine-internal places:

- `Dataflow.stream` -- the edge-level stream attached to dataflows that carry streaming data between tasks.
- `TaskGraphRunner` fan-out -- when one upstream streaming task feeds multiple downstream consumers, the engine uses `ReadableStream.tee()` to split the stream cleanly.

Why ReadableStream is the right tool here:

- `tee()` is the correct fan-out primitive -- splitting an `AsyncIterable` to N consumers would require building (and maintaining) a custom broadcaster.
- `cancel()` back-propagates to the producer, matching the existing abort plumbing.
- It is a Web-platform standard available uniformly in browsers, workers, Node, and Bun.

**Authors do not write `ReadableStream` directly.** The engine wraps task-authored `AsyncIterable`s into `ReadableStream`s at the dataflow edge. If you find yourself reaching for `new ReadableStream(...)` in a task, you are on the wrong layer.

One exception lives in `HFT_Pipeline.ts`: that code wraps an HTTP `Response.body` (already a `ReadableStream<Uint8Array>`) into an abort-aware, pull-based `ReadableStream<Uint8Array>` for multi-GB model downloads. That wrapping is below the task layer -- it is shaping an external I/O primitive, not authoring a task stream.

### Observation-Only: EventEmitter

Tasks emit `stream_start`, `stream_chunk`, and `stream_end` via `EventEmitter` for UI and telemetry observers. These events:

- **MUST NOT** be used for data transfer between tasks. Data transfer goes through dataflows (AsyncIterable -> engine tee -> downstream consumer).
- Carry no backpressure. A slow listener cannot slow a producer. This is intentional -- observers must never be able to stall the pipeline.
- Are safe to subscribe to from any number of listeners.

### Which Primitive Do I Use?

| Task                                            | Answer                                                 |
| ----------------------------------------------- | ------------------------------------------------------ |
| Writing a new task that streams output          | `async *executeStream()` returning `AsyncIterable`     |
| Writing a new AI provider stream function       | `AiProviderStreamFn` (async generator)                 |
| Passing streaming data between two tasks        | Don't -- the engine handles this via dataflows         |
| Forking one stream to multiple downstream tasks | Don't -- the engine tees via `ReadableStream.tee()`    |
| Subscribing to streaming progress from the UI   | `graph.subscribeToTaskStreaming({...})` (EventEmitter) |
| Logging or telemetry on streaming lifecycle     | `task.on("stream_chunk", ...)` (EventEmitter)          |

---

## Stream Modes

### The x-stream Annotation

The `x-stream` annotation on output port schemas declares how a task produces streaming output. When a task's output schema includes ports with `x-stream`, and the task implements `executeStream()`, the TaskRunner uses the streaming execution path.

### Available Stream Modes

#### none (default)

No streaming. The task returns its output as a complete `Promise<Output>` from `execute()`. This is the default when `x-stream` is absent.

```typescript
// No x-stream annotation: standard execution
properties: {
  result: {
    type: "string",
  },
}
```

#### append

Each chunk is a **text delta** -- a new token or fragment to be appended to the accumulated output. The consumer is responsible for concatenating deltas.

```typescript
properties: {
  text: {
    type: "string",
    "x-stream": "append",  // Token-by-token streaming
  }
}
```

Produces `StreamTextDelta` events:

```typescript
{ type: "text-delta", port: "text", textDelta: " Hello" }
{ type: "text-delta", port: "text", textDelta: " world" }
{ type: "text-delta", port: "text", textDelta: "!" }
// Accumulated: " Hello world!"
```

#### replace

Each chunk is a **complete snapshot** of the output so far. The consumer replaces its state with the latest snapshot.

```typescript
properties: {
  image: {
    type: "object",
    "x-stream": "replace",  // Progressive refinement
  }
}
```

Produces `StreamSnapshot` events:

```typescript
{ type: "snapshot", data: { image: lowResVersion } }
{ type: "snapshot", data: { image: mediumResVersion } }
{ type: "snapshot", data: { image: highResVersion } }
```

#### object

Each chunk is a **progressively more complete partial object**. The consumer replaces (not merges) its state with each update.

```typescript
properties: {
  structured: {
    type: "object",
    "x-stream": "object",  // Structured streaming
  }
}
```

Produces `StreamObjectDelta` events:

```typescript
{ type: "object-delta", port: "structured", objectDelta: { name: "Al" } }
{ type: "object-delta", port: "structured", objectDelta: { name: "Alice", age: 30 } }
{ type: "object-delta", port: "structured", objectDelta: { name: "Alice", age: 30, role: "Engineer" } }
```

#### mixed

When multiple output ports use different stream modes, the overall task stream mode is `"mixed"`. This is detected automatically by `getOutputStreamMode()`:

```typescript
properties: {
  text: { type: "string", "x-stream": "append" },
  metadata: { type: "object", "x-stream": "object" },
}
// getOutputStreamMode() returns "mixed"
```

---

## StreamEvent Types

All streaming data flows through the `StreamEvent` discriminated union type:

```typescript
type StreamEvent<Output = Record<string, any>> =
  | StreamTextDelta
  | StreamTextRetract
  | StreamObjectDelta
  | StreamSnapshot<Output>
  | StreamFinish<Output>
  | StreamError;
```

(Abridged: the union also carries `binary-delta`, `refusal`, `usage`, `phase` and `tool-call`
events; see `StreamTypes.ts`.)

### StreamTextDelta

```typescript
interface StreamTextDelta {
  type: "text-delta";
  port: string; // Output port name
  textDelta: string; // Incremental text fragment
}
```

Used with `x-stream: "append"`. Each event carries a fragment of text that should be appended to the accumulated result for the named port.

### StreamTextRetract

```typescript
interface StreamTextRetract {
  type: "text-retract";
  port: string; // Output port name
  length: number; // UTF-16 code units to take back
}
```

Append mode only. Removes the last `length` characters streamed on `port` in this run, clamped at
the start; later `text-delta`s append after what remains. Every consumer folding a port's text
truncates with `retractText(acc, length)`, which removes `retractionLength(length)` characters (a
fraction rounds down, and anything not positive removes nothing). A
producer that streams text it may yet abandon uses it: `AgentTask` forwards each round live and,
when an attempt fails and is retried, takes back exactly what that attempt sent, so the folded port
reads as if the attempt never ran. Dataflow edges carrying the port carry the retraction too.

A port whose text was already teed to a cache sink cannot be truncated there: the processor fails
that port's sink (discarding the partial write) and settles the port inline from the accumulator
for the rest of the run. With no accumulator either, the run fails at `finish` unless the finish
payload states the port's value itself.

### StreamObjectDelta

```typescript
interface StreamObjectDelta {
  type: "object-delta";
  port: string; // Output port name
  objectDelta: Record<string, unknown> | unknown[]; // Progressive partial object
}
```

Used with `x-stream: "object"`. Each event carries a progressively more complete object snapshot. Consumers should **replace** (not merge) their state with the latest delta.

### StreamSnapshot

```typescript
interface StreamSnapshot<Output = Record<string, any>> {
  type: "snapshot";
  data: Output; // Complete snapshot of current output state
}
```

Used with `x-stream: "replace"`. Each event carries a full snapshot of the output. During graph execution, the runner updates `task.runOutputData` with the snapshot before emitting the `stream_chunk` event.

### StreamFinish

```typescript
interface StreamFinish<Output = Record<string, any>> {
  type: "finish";
  data: Output; // Final output data
}
```

Signals that the stream has ended. In append mode, the TaskRunner enriches this event with accumulated text (when `shouldAccumulate` is true). In replace mode, `data` contains the final output.

**Provider convention**: Provider stream functions must yield `{ type: "finish", data: {} as Output }` -- an empty finish event. The TaskRunner handles accumulation. Providers must not accumulate deltas themselves.

### StreamError

```typescript
interface StreamError {
  type: "error";
  error: Error; // The error that occurred
}
```

Signals that the stream encountered a fatal error. The TaskRunner throws this error, transitioning the task to `FAILED` status.

---

## Stream Lifecycle

### 1. Detection

Before executing a task, the TaskRunner checks whether streaming is appropriate:

```typescript
function isTaskStreamable(task): boolean {
  // Must implement executeStream()
  if (typeof task.executeStream !== "function") return false;
  // Must have at least one x-stream annotated output port
  return getOutputStreamMode(task.outputSchema()) !== "none";
}
```

If a task declares streaming output via `x-stream` but does not implement `executeStream()`, the runner falls back to non-streaming `execute()` and logs a warning.

### 2. Stream Start

When streaming begins, the TaskRunner:

1. Validates the output schema has appropriate `x-stream` annotations
2. Emits `stream_start` event on the task
3. Calls `task.executeStream(input, context)` to obtain the async iterable
4. Begins consuming events

### 3. Chunk Processing

For each event from the async iterable:

```
text-delta:
  - Accumulate text per-port (if shouldAccumulate)
  - Emit "stream_chunk" on the task
  - Update progress (asymptotic curve: 1 - e^(-0.05*chunkCount))

text-retract:
  - Truncate the port's accumulated text (if shouldAccumulate)
  - Fail that port's cache sink, if one was teed (see StreamTextRetract)
  - Emit "stream_chunk" on the task

object-delta:
  - Accumulate per-port (if shouldAccumulate)
  - Update runOutputData progressively
  - Emit "stream_chunk"

snapshot:
  - Update runOutputData BEFORE emitting (so listeners see latest state)
  - Emit "stream_chunk"

finish:
  - If accumulating: merge accumulated text/objects into finish data
  - Set finalOutput
  - Emit enriched "stream_chunk" with complete data

error:
  - Throw the error (handled by run()'s catch block)
```

After the first chunk, the task status transitions to `STREAMING`.

### 4. Stream End

After all events are consumed:

1. Check if the task was aborted during streaming
2. Set `task.runOutputData` to the final accumulated output
3. Emit `stream_end` event with the complete output
4. Return the final output

---

## Delta Accumulation

### The shouldAccumulate Flag

The TaskRunner's `shouldAccumulate` flag controls whether text-delta and object-delta events are accumulated into a final output value:

- **`true` (default)**: Text deltas are concatenated per-port. Object deltas are stored per-port. The finish event is enriched with accumulated data before emission.
- **`false`**: All events pass through unmodified. No accumulation maps are maintained.

### When Accumulation is Needed

The graph runner sets `shouldAccumulate` based on whether any downstream edge needs materialized data:

- **Accumulate**: When the task has downstream dataflows that need complete values, or when caching is enabled.
- **Don't accumulate**: When all downstream edges are also streaming (pure pass-through) and no cache is needed.

### Accumulation Example

Given a streaming AI task with `x-stream: "append"` on the `text` port:

```
Event 1: { type: "text-delta", port: "text", textDelta: "Hello" }
Event 2: { type: "text-delta", port: "text", textDelta: " world" }
Event 3: { type: "text-delta", port: "text", textDelta: "!" }
Event 4: { type: "finish", data: { model: "gpt-4" } }  // Provider finish (no text)
```

With `shouldAccumulate = true`, the runner:

1. Accumulates: `text -> "Hello world!"`
2. On finish: merges accumulated text into finish data
3. Emits enriched finish: `{ type: "finish", data: { text: "Hello world!", model: "gpt-4" } }`
4. Downstream dataflows receive `{ text: "Hello world!", model: "gpt-4" }` as the materialized value

### Dataflow Stream Materialization

When a dataflow carries a stream (rather than a materialized value), calling `dataflow.awaitStreamValue()` consumes the stream to completion:

```typescript
await dataflow.awaitStreamValue();
// After: dataflow.value contains the materialized port data
// After: dataflow.stream is cleared (set to undefined)
```

The method prioritizes events:

1. `snapshot` events: Use the last snapshot data
2. `finish` events: Use the finish data (which may include accumulated text from the source)
3. `text-delta` / `object-delta`: Ignored here (source task handles accumulation)

### Edge-Level Accumulation Detection

The `edgeNeedsAccumulation()` function determines whether a specific dataflow edge needs its source's stream to be accumulated:

```typescript
function edgeNeedsAccumulation(sourceSchema, sourcePort, targetSchema, targetPort): boolean {
  const sourceMode = getPortStreamMode(sourceSchema, sourcePort);
  if (sourceMode === "none") return false;
  const targetMode = getPortStreamMode(targetSchema, targetPort);
  return sourceMode !== targetMode;
}
```

If the source port streams in "append" mode but the target port does not declare "append" on its input, the edge needs accumulation to materialize the value.

---

## Cancel Semantics

Every task execution carries an `AbortSignal`. What happens when it fires, and what each task is responsible for, is defined here.

### Signal Origin and Propagation

Each `TaskRunner` owns an `AbortController`, created in `handleStart()` and wired into the task via `IExecuteContext.signal`:

```
┌─────────────────┐  AbortSignal   ┌──────────────────────────┐
│ TaskRunner      │ ─────────────> │ task.execute(input, ctx) │
│  AbortController│                │ task.executeStream(...)  │
└─────────────────┘                │    ctx.signal ───────────┼──> provider / fetch / SDK
                                   └──────────────────────────┘
```

- `taskRunner.abort()` calls `AbortController.abort()` on its own controller, and recursively aborts any owned subgraph (`task.subGraph.abort()`).
- Graph-level `graph.abort()` aborts every active task runner in the graph.
- Aborting an upstream task causes its dataflows to transition to `ABORTING` (the terminal aborted state); downstream tasks that have not yet started will never start.

### What Every Task MUST Do on Abort

1. **Either poll `context.signal.aborted`** at safe loop boundaries, **or forward `context.signal`** to any I/O it performs (fetch, SDK client, subprocess, child task).
2. **Stop producing output promptly.** A streaming task's generator must return (or throw) on the next `yield` point after abort, not continue producing events.
3. **Release resources.** Close readers, cancel timers, unregister listeners. A `try { ... } finally { ... }` block in an `async *executeStream()` generator is the idiomatic cleanup hook -- `finally` runs when the consumer stops iterating (including on abort).
4. **Throw `TaskAbortedError`** if the abort is detected inside `execute()` / `executeStream()`. The TaskRunner also detects abort on its own and converts it to a `TaskAbortedError` when the generator finishes after the signal fires, via the post-stream abort check in `TaskRunner.executeStreamingTask`.

Tasks **do not** need to manually set the task status -- the runner's `handleAbort()` transitions the task to `ABORTING` (the terminal aborted state) and attaches a `TaskAbortedError`.

### Partial-Result Contract

When a streaming task is aborted mid-stream:

- `task.runOutputData` **may contain partially accumulated data** (whatever text deltas or object deltas were received before the abort).
- `task.status` transitions to `ABORTING` (the terminal aborted state -- there is no separate `ABORTED` value).
- `task.error` is set to a `TaskAbortedError`.
- Downstream consumers **MUST treat `ABORTING` status as a failure**, not as a valid result, even if `runOutputData` looks superficially complete.

If you need guaranteed-complete results for a downstream computation, check `task.status === COMPLETED` before reading `runOutputData`.

### Downstream Propagation

When an upstream task aborts, the graph runner's behavior depends on the downstream task's current state:

| Downstream state | What happens                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PENDING`        | Task is never started. Its dataflows transition to `ABORTING`.                                                    |
| `PROCESSING`     | Receives abort via its own `AbortSignal` (which was derived from the graph). Task follows the normal cancel path. |
| `STREAMING`      | Receives an `error` `StreamEvent` on its input stream; runner throws `TaskAbortedError`.                          |
| `COMPLETED`      | No effect -- completed tasks are immutable.                                                                       |

### Per-Task JSDoc Convention

Any task overriding `executeStream()` (or `execute()` with non-trivial cancel behavior) **SHOULD** document its cancel contract in a `@cancel` JSDoc tag on the class or method. Minimum contents:

- What I/O or resources are opened during execution.
- What happens to partial state on abort (discarded, flushed, etc.).
- Whether side effects are reversible.

Example:

```typescript
/**
 * Streams text from an HTTP endpoint.
 *
 * @cancel Forwards `context.signal` to the underlying `fetch`. On abort:
 * the HTTP connection is torn down by the browser/runtime, the reader is
 * released in the generator's `finally` block, and any partial text
 * accumulated on the task is discarded (status becomes `ABORTING`).
 * No side effects to clean up.
 */
async *executeStream(input, context): AsyncIterable<StreamEvent> { ... }
```

For provider stream functions (`AiProviderStreamFn`), the equivalent contract is documented on the function type itself -- signal forwarding to the underlying SDK is mandatory.

### Known Gaps

- **Per-provider cancel forwarding audit** -- most providers (Anthropic, OpenAI, Gemini, Ollama, llamacpp) rely on their SDK's handling of `AbortSignal`. A systematic audit confirming each SDK promptly stops yielding after abort is still open.
- **Bounded tee buffer** -- `ReadableStream.tee()` buffers for the slowest consumer with no cap. A `maxBufferedEvents` safety limit is a possible future hardening.

---

## Dataflow Event System

Dataflows emit events for lifecycle changes:

| Event       | Parameters   | Description                       |
| ----------- | ------------ | --------------------------------- |
| `start`     | --           | Dataflow status set to PROCESSING |
| `streaming` | --           | Dataflow status set to STREAMING  |
| `complete`  | --           | Dataflow status set to COMPLETED  |
| `error`     | `TaskError`  | Dataflow status set to FAILED     |
| `abort`     | --           | Dataflow status set to ABORTING   |
| `disabled`  | --           | Dataflow status set to DISABLED   |
| `reset`     | --           | Dataflow reset to initial state   |
| `status`    | `TaskStatus` | Any status change                 |

### Subscribing to Dataflow Events

```typescript
const unsub = dataflow.subscribe("status", (status) => {
  console.log(`Dataflow ${dataflow.id}: ${status}`);
});

// One-time listener
dataflow.once("complete", () => {
  console.log(`Value: ${dataflow.value}`);
});

// Promise-based wait
await dataflow.waitOn("complete");
```

### Graph-Level Dataflow Subscription

```typescript
const unsub = graph.subscribeToDataflowStatus((dataflowId, status) => {
  console.log(`Dataflow ${dataflowId}: ${status}`);
});
```

---

## API Reference

### Dataflow Class

```typescript
class Dataflow {
  // Construction
  constructor(sourceTaskId, sourceTaskPortId, targetTaskId, targetTaskPortId);
  static createId(sourceTaskId, sourcePortId, targetTaskId, targetPortId): DataflowIdType;

  // Identity
  readonly id: DataflowIdType;
  sourceTaskId: TaskIdType;
  sourceTaskPortId: string;
  targetTaskId: TaskIdType;
  targetTaskPortId: string;

  // State
  value: any;
  status: TaskStatus;
  error: TaskError | undefined;
  stream: ReadableStream<StreamEvent> | undefined;

  // Value management
  setPortData(entireDataBlock: any): void;
  getPortData(): TaskOutput;
  setStatus(status: TaskStatus): void;
  reset(): void;

  // Stream management
  setStream(stream: ReadableStream<StreamEvent>): void;
  getStream(): ReadableStream<StreamEvent> | undefined;
  awaitStreamValue(): Promise<void>;

  // Compatibility
  semanticallyCompatible(graph, dataflow): "static" | "runtime" | "incompatible";
  invalidateCompatibilityCache(): void;

  // Events
  subscribe(event, callback): () => void;
  on(event, callback): void;
  off(event, callback): void;
  once(event, callback): void;
  waitOn(event): Promise<any>;
  emit(event, ...args): void;

  // Serialization
  toJSON(): DataflowJson;
}
```

### DataflowArrow Helper

For constructing dataflows from the string ID format:

```typescript
const dataflow = new DataflowArrow("taskA[result] ==> taskB[value]");
// Equivalent to: new Dataflow("taskA", "result", "taskB", "value")
```

### Stream Helper Functions

```typescript
// Get the stream mode of a specific port
function getPortStreamMode(schema: DataPortSchema, portId: string): StreamMode;

// Get all streaming ports with their modes
function getStreamingPorts(schema: DataPortSchema): Array<{ port: string; mode: StreamMode }>;

// Get the dominant output stream mode for a task
function getOutputStreamMode(outputSchema: DataPortSchema): StreamMode;

// Check if a task supports streaming execution
function isTaskStreamable(task: { outputSchema(); executeStream? }): boolean;

// Get the first append-mode port name
function getAppendPortId(schema: DataPortSchema): string | undefined;

// Get the first object-mode port name
function getObjectPortId(schema: DataPortSchema): string | undefined;

// Check if a dataflow edge needs value accumulation
function edgeNeedsAccumulation(sourceSchema, sourcePort, targetSchema, targetPort): boolean;

// Get schemas for structured output ports
function getStructuredOutputSchemas(schema: DataPortSchema): Map<string, JsonSchema>;

// Check if any port has structured output
function hasStructuredOutput(schema: DataPortSchema): boolean;
```

---

## Examples

### Basic Dataflow Wiring

```typescript
import { Task, TaskGraph, Dataflow } from "@workglow/task-graph";

const producer = new ProducerTask({ id: "producer" });
const consumer = new ConsumerTask({ id: "consumer" });

const graph = new TaskGraph();
graph.addTasks([producer, consumer]);
graph.addDataflow(new Dataflow("producer", "output", "consumer", "input"));

const results = await graph.run();
```

### Streaming AI Task

```typescript
class StreamingTextTask extends Task<{ prompt: string }, { text: string }> {
  static readonly type = "StreamingTextTask";
  static readonly cachePolicy = { kind: "none" } as const;

  static outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        text: {
          type: "string",
          "x-stream": "append", // Enable append-mode streaming
        },
      },
    } as const satisfies DataPortSchema;
  }

  async *executeStream(input, context): AsyncIterable<StreamEvent> {
    const response = await fetch("/api/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: input.prompt }),
      signal: context.signal,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      yield {
        type: "text-delta",
        port: "text",
        textDelta: decoder.decode(value),
      };
    }

    yield { type: "finish", data: {} as any };
  }
}
```

### Subscribing to Stream Events

```typescript
const graph = new TaskGraph();
// ... add streaming tasks ...

// Listen for streaming events at the graph level
const unsub = graph.subscribeToTaskStreaming({
  onStreamStart: (taskId) => {
    console.log(`Stream started: ${taskId}`);
    showSpinner(taskId);
  },
  onStreamChunk: (taskId, event) => {
    if (event.type === "text-delta") {
      appendToUI(taskId, event.textDelta);
    } else if (event.type === "object-delta") {
      updateStructuredView(taskId, event.objectDelta);
    }
  },
  onStreamEnd: (taskId, output) => {
    console.log(`Stream ended: ${taskId}`, output);
    hideSpinner(taskId);
  },
});

await graph.run({ prompt: "Explain quantum computing" });
unsub();
```

### Wildcard Port Dataflow

```typescript
// Pass entire output object as input using DATAFLOW_ALL_PORTS
import { DATAFLOW_ALL_PORTS } from "@workglow/task-graph";

graph.addDataflow(
  new Dataflow(
    "producer",
    DATAFLOW_ALL_PORTS, // All output properties
    "consumer",
    DATAFLOW_ALL_PORTS // Spread into all input properties
  )
);
```

### Checking Port Compatibility

```typescript
const dataflow = new Dataflow("taskA", "text", "taskB", "input");
graph.addDataflow(dataflow);

const compat = dataflow.semanticallyCompatible(graph, dataflow);
if (compat === "incompatible") {
  console.warn(`Port types are incompatible: ${dataflow.id}`);
}
```

### Object Streaming for Structured Data

```typescript
class StructuredOutputTask extends Task<{ query: string }, { result: object }> {
  static outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          type: "object",
          "x-stream": "object",
          "x-structured-output": true,
          properties: {
            name: { type: "string" },
            age: { type: "number" },
            skills: { type: "array", items: { type: "string" } },
          },
        },
      },
    } as const satisfies DataPortSchema;
  }

  async *executeStream(input, context): AsyncIterable<StreamEvent> {
    // Simulate progressive object construction
    yield { type: "object-delta", port: "result", objectDelta: { name: "Alice" } };
    yield { type: "object-delta", port: "result", objectDelta: { name: "Alice", age: 30 } };
    yield {
      type: "object-delta",
      port: "result",
      objectDelta: { name: "Alice", age: 30, skills: ["TypeScript", "Rust"] },
    };
    yield { type: "finish", data: {} as any };
  }
}
```
