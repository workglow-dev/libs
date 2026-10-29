# Task Graph Execution Model

This document explains the internal execution model of the task graph system. It is intended for developers (human or AI) who need to understand or modify the execution logic.

## Table of Contents

- [Overview](#overview)
- [Task Lifecycle](#task-lifecycle)
- [Normal Execution (run)](#normal-execution-run)
- [Preview Execution (runPreview)](#preview-execution-runpreview)
- [Cache, Run Identity, and Durable Execution](#cache-run-identity-and-durable-execution)
- [Dataflow and Input Propagation](#dataflow-and-input-propagation)
- [GraphAsTask (Subgraphs)](#graphastask-subgraphs)
- [Key Invariants](#key-invariants)
- [Common Pitfalls](#common-pitfalls)

---

## Overview

The task graph system has two **strictly orthogonal** execution paths:

1. **`run()`** — Full execution that produces cached, immutable results by calling `execute()` (or `executeStream()`).
2. **`runPreview()`** — Lightweight execution for UI updates and previews by calling `executePreview()`.

`run()` never invokes `executePreview()`, and `runPreview()` never invokes `execute()` or `executeStream()`. Cache hits return the cached value verbatim.

---

## Task Lifecycle

### Task Statuses

```
PENDING → PROCESSING → COMPLETED
                    ↘ FAILED
                    ↘ ABORTING (→ FAILED when the abort surfaces as an error)
```

| Status       | Description                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `PENDING`    | Task has not been executed yet. Inputs can be modified.                                                       |
| `PROCESSING` | Task is currently executing.                                                                                  |
| `COMPLETED`  | Task has finished successfully. **Output is locked and immutable.**                                           |
| `FAILED`     | Task execution threw an error.                                                                                |
| `ABORTING`   | Task was cancelled via `abort()`. Terminal unless the abort error surfaces, which moves the task to `FAILED`. |

### Key Properties

Each task maintains:

- `defaults` - Default input values set at construction time
- `runInputData` - The actual input used for execution (defaults + overrides)
- `runOutputData` - The output produced by execution
- `status` - Current lifecycle status

---

## Normal Execution (run)

### Purpose

Full execution that:

- Runs the task's `execute()` (or `executeStream()`) method
- Produces cached, deterministic results
- Transitions task to `COMPLETED` status
- Makes output immutable

### Flow

```
Task.run(overrides)
    ↓
TaskRunner.run(overrides)
    ↓
1. Guard: if task overrides executePreview() but not execute(),
   throw TaskConfigurationError
2. setInput(overrides)           # Merge overrides into runInputData
3. resolveSchemaInputs()         # Resolve model/repository strings to instances
4. validateInput()               # Validate against input schema
5. Check cache                   # Per task's CachePolicy + CacheRegistry slot;
                                 # cache hit returns verbatim, no preview overlay
6. executeTask()                 # Call task.execute(input, context) only
7. Store in cache                # If policy ≠ "none" and slot present, persist the result
8. handleComplete()              # Set status = COMPLETED
    ↓
Return runOutputData (locked)
```

`executePreview()` is never called as part of `run()`. There is no post-execute overlay, even on cache hits or after `executeStream()` finishes.

### Graph-Level Execution

```
TaskGraph.run(input)
    ↓
TaskGraphRunner.runGraph(input)        # facade: lifecycle + terminal precedence
    ↓
RunScheduler.runLoop(...)              # owns the for-await loop
    ↓
For each task (from processScheduler.tasks()):
    1. StreamPump.prepareStreamingInputs(task)          # Tee streaming inputs
    2. StreamPump.awaitStreamInputs(task, registry)     # Materialize pending streams
    3. EdgeMaterializer.copyInputFromEdgesToNode(task)  # Pull data from incoming dataflows
    4. ctx.activeEnforcer?.checkTask(task)              # Runtime entitlement
    5. Streaming:     StreamPump.runStreamingTask(...)
       Non-streaming: task.runner.run(...) → EdgeMaterializer.pushOutputFromNodeToEdges()
    6. RunScheduler.pushStatusFromNodeToEdges + processScheduler.onTaskCompleted
    ↓
Return results from ending nodes (no outgoing dataflows)
```

`TaskGraphRunner` is a thin facade. The for-await loop lives in `RunScheduler`; per-task choreography lives in the facade's `runTask`; per-run mutable state (abort controller, in-progress maps, timeout timer, telemetry span, entitlement enforcer) lives in a `RunContext` value object built by `handleStart` and discarded by terminal handlers. See `docs/technical/01-task-graph-dag-engine.md` for the full architecture and the `TaskGraphRunConfig` vs `RunContext` distinction.

### Runtime guard

`TaskRunner.run()` checks at the start of execution whether the task overrides `executePreview()` but not `execute()`. If so, it throws `TaskConfigurationError`. The check fires on `run()`, not on construction. `runPreview()` does not trigger the guard.

---

## Preview Execution (runPreview)

### Purpose

Lightweight execution for:

- UI previews and updates
- Fast transformations (e.g., image filters)
- Propagating intermediate results through PENDING tasks

**Important:** Preview execution only affects `PENDING` tasks. `COMPLETED` tasks return their cached output unchanged.

### Use Case Example

```
User edits an InputNode default → Task is PENDING
    ↓
runPreview() is called
    ↓
InputTask (PENDING) receives new value
    ↓
Downstream tasks (PENDING) get preview updates
    ↓
Tasks run their executePreview() for quick previews
    ↓
Eventually run() is called → All tasks become COMPLETED (locked)
```

### Task-Level Flow

```
Task.runPreview(overrides)
    ↓
TaskRunner.runPreview(overrides)
    ↓
1. If status == PROCESSING: return existing output (no re-entry)
2. setInput(overrides)                    # Update runInputData
3. resolveSchemaInputs()                  # Resolve strings to instances
4. handleStartPreview()                   # previewRunning = true
5. validateInput()
6. executeTaskPreview(input)              # Call task.executePreview()
7. If result !== undefined: runOutputData = result   # No merge
   Else: leave runOutputData unchanged
8. handleCompletePreview()                # previewRunning = false
    ↓
Return runOutputData
```

### Graph-Level Flow

```
TaskGraph.runPreview(input)
    ↓
TaskGraphRunner.runGraphPreview(input)
    ↓
For each task (in topological order):
    ↓
    ┌─ If status == PENDING:
    │      resetInputData()              # Reset to defaults
    │      copyInputFromEdgesToNode()    # Pull from incoming dataflows
    └─ Else (COMPLETED):
           Skip input modification       # Output is locked
    ↓
    If isRootTask (no incoming dataflows):
        taskInput = input                # Pass graph input to root tasks
    Else:
        taskInput = {}
    ↓
    task.runPreview(taskInput)
    ↓
    pushOutputFromNodeToEdges()          # Push output to dataflows
    ↓
Return results from ending nodes
```

### The executePreview Method

```typescript
// Default implementation - returns undefined, leaves runOutputData unchanged
async executePreview(input, context): Promise<Output | undefined> {
    return undefined;
}

// Custom implementation for quick transformations
async executePreview(input, context): Promise<Output | undefined> {
    // Lightweight operation (< 1ms)
    return { preview: this.quickTransform(input) };
}
```

Return-value semantics:

- Non-`undefined` `Output` — replaces `runOutputData` entirely. **No merge** with prior output.
- `undefined` — leaves `runOutputData` unchanged.

If a preview needs the prior output, it can read `this.runOutputData` directly.

---

## Cache, Run Identity, and Durable Execution

### Cache policy

Every task declares a `CachePolicy` — a property of the task type, not of the deployment:

| Kind            | Meaning                                                                                  | Cache slot used     |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| `deterministic` | Same inputs → same outputs. Safe to share across runs (and, in apps, across projects).   | `deterministic`     |
| `private`       | Non-deterministic but worth caching for the lifetime of one run (e.g., seedless images). | `private` (per-run) |
| `none`          | Do not cache. Side-effecting tasks (writes to external systems, sends, mutations).       | _none_              |

The default is `{ kind: "deterministic" }`. Policy can be made input-dependent by overriding `getCachePolicy(inputs)` — e.g., an image task that returns `deterministic` when a seed is provided and `private` when it isn't.

### CacheRegistry

A two-slot service registered under `CACHE_REGISTRY`:

```ts
interface CacheRegistry {
  deterministic?: TaskOutputRepository;
  private?: TaskOutputRepository;
}
```

`TaskGraphRunner` resolves the registry from the per-run `ServiceRegistry` and dispatches each task's read/write to the slot named by its policy. Both slots are independently optional. A missing slot is a silent no-op: the task runs uncached, no error.

For the `private` slot, the runner constructs a per-run `RunPrivateCacheRepo` wrapper that threads `runId` into the backing `RunPrivateTaskOutputRepository`, whose rows carry `runId` as a first-class column under a runId-leading primary key `(runId, key, taskId)`. Two runs with different `runId`s never see each other's rows; the same `runId` (a restart) does. Two task nodes of the same class in one graph never share private entries because each keys by its instance id, not its type.

### Run identity (`runId`)

`runId` is an opaque string passed in `TaskGraphRunConfig`. `TaskGraph.run` takes `(input, config)` — `runId` lives in the config (second argument), not the input:

```ts
graph.run({}, { runId, registry, ... });
```

The caller owns generation. The contract:

- A user-triggered run gets a fresh `runId` (UUID typical).
- A restart after a crash uses the **same** `runId` — that is how durable resume works.
- Concurrent runs of the same workflow get **different** `runId`s.

`handleStart` rejects the run synchronously only when **all** of the following hold: a `CACHE_REGISTRY` is registered, its `private` slot is populated, and the graph contains at least one task whose policy may resolve to `kind: "private"` (a static `cachePolicy` of that kind, or a `getCachePolicy(inputs)` override that can return it). Graphs without a private slot — or without any private-policy task — can omit `runId`.

### Cache key

```
key = sha256(taskType + getCacheVersion() + fingerprint(inputs))
```

`fingerprint(inputs)` reuses the `PortCodec` normalization in `CacheCoordinator` — ports with `format` annotations hash by their canonical wire representation. Run scoping (the `runId` column for the private tier) is handled by the repo wrapper, not the key function.

`getCacheVersion()` walks the prototype chain and combines each ancestor's static `version` (default `1`). Bump `version` on a task when its semantics change — every prior cached entry becomes a miss.

### Lifecycle of cache rows

| Tier            | Written         | Read                                       | Deleted                                                                                                                                                                             |
| --------------- | --------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deterministic` | On task success | On task start                              | Never automatically. App owns invalidation (typically via `version` bumps).                                                                                                         |
| `private`       | On task success | On task start, filtered to current `runId` | **(a)** `privateRepo.clearRun()` on `succeeded` (the wrapper already knows its `runId`). **(b)** TTL sweep via `CacheJanitor.sweepStaleRunPrivate(olderThanMs)` for abandoned runs. |

Failed tasks are never cached — only `Ok` results reach `saveOutput`. `saveOutput` is upsert by primary key (last writer wins) — the underlying `TaskOutputTabularRepository` calls `put()` on its tabular storage, so a same-key write replaces the existing row.

**`clearRun()` costs what the run wrote, not what the store holds.** It fires after every successful run, so it must not scale with the cache. A backing with a runId-leading primary key (`RunPrivateTaskOutputRepository`) answers with one indexed `deleteSearch({ runId })`. A backing that can only find a run's rows by scanning — `FsFolderTaskOutputRepository`, whose rows are keyed `(taskType, fingerprint)` one file each — is instead handed the rows to delete: `RunPrivateCacheRepo` mediates every private row write, so it records each `(taskType, key)` it wrote and passes that write-set to `deleteRunEntries(runId, entries)`. Streamed sidecar blobs are named the same way: a blob's name is not derivable from a row key (the row key fingerprints the inputs; the blob name fingerprints `{__taskType, inputs}` and carries a per-write uuid), so `RunPrivateCacheRepo` also records every `CacheRef` its stream writer returned and deletes those through `deleteOutputByRefForRun`. Cleanup is then one unlink per row plus one per streamed blob, with **no `readdir`** of the blobs directory, and a run that wrote nothing does essentially nothing (previously: a full read-and-parse of every row file in the folder, per run, including unrelated runs' cached values, plus a `readdir` across every run's blobs). The backing sweeps no blobs of its own on this path, because a prefix is the only selector it has and a prefix reaches the blobs of rows it was told to KEEP.

The write-set covers the current process only. Rows left under the same `runId` by a previous attempt (a crash-resume) are not in it and survive `clearRun()` — and so does each such row's sidecar blob, which is the point of not sweeping by prefix: the pair survives together, so the surviving row's `CacheRef` still resolves rather than dangling into a blob a later attempt's cleanup removed. The age sweep (`CacheJanitor` / `clearOlderThan` → `deleteRunOlderThan`) reclaims those and **still scans**, because it is reached with no knowledge of what the run wrote. A backing declaring neither `deleteRunEntries` nor `keyFromInputs`, and any run whose write-set could not be recorded in full, fall back to the exhaustive `deleteRun`.

### Binary cache stream-out (refs on the read path)

Binary output ports whose bytes were piped into a stream-capable cache carry a branded `CacheRef` in the cached row. On a **cache hit**, the runner mirrors the fresh-run event contract, driven by two graph-computed consumer hints (`IRunConfig.hasStreamingConsumers` / `hasMaterializingConsumers`):

- **Stream-capable consumer** (`x-stream: "binary"` on both ends of an edge): the cached bytes replay as chunked `binary-delta` events, pull-paced from the repository's streaming reader (`getOutputStreamByRef`), so memory stays bounded by the read chunk size. The finish event keeps the ref at the port.
- **Materializing consumer** (target port cannot consume the stream): the ref hydrates into the **enriched finish event** as a `Blob`/`ArrayBuffer` (per the port's `format`), exactly what a fresh run's accumulator would have delivered. The _returned_ output still carries the small ref.
- **No consumers**: no reads are performed; the synthetic finish carries the ref unchanged (callers resolve via `resolveOutput` / `resolveJobOutputStream`).

**Rows store the wire form**: the cached row always carries the `CacheRef`, never inline bytes — JSON-row backings would destroy an inline `Blob`/`ArrayBuffer` (`JSON.stringify(Blob)` is `{}`). Below-threshold hydration to inline bytes applies to the value **returned to the caller**, identically on fresh runs and cache hits.

**Binary-only, any number of ports**: this path takes one _or more_ binary output ports — each gets its own sink and its own `CacheRef`, and `mintRefKey(taskType, fingerprint, port)` keeps the blobs distinct. What it does not take is a **mix**: a task whose streaming ports are not all binary falls back to accumulation (enforced in both `StreamPump.canStreamBinaryToCache` and `CacheCoordinator.getBinaryRefSinksByPolicy`), because only the binary ports get sinks here, so an `append` / `object` port alongside them would have neither a sink nor — with accumulation skipped — an accumulator, and its deltas would be dropped into an empty finish payload. Such mixed tasks stream every port only under the per-port path below.

**A standalone run gets the same relaxation.** `canStreamBinaryToCache` is computed by `StreamPump`, so it exists only for a task the graph schedules; a bare `task.run()` (including an owned child — `own()` registers a task in the parent's subgraph but the child still runs through its own runner) leaves `shouldAccumulate` at its default of `true`, and a binary-only producer therefore streamed to the sink AND buffered the whole artifact for a finish payload nobody reads. `TaskRunner` now makes the standalone half of that call itself: when no caller stated `shouldAccumulate`, a sink resolved for **every** streaming port, and `allStreamingPortsAreBinary` holds (the same predicate `canStreamBinaryToCache` uses, shared so the two cannot drift), accumulation is skipped. The three gates replace the consumer analysis a standalone run cannot do — and the difference is confined to the emitted `finish` **stream event**: the returned Output carries the sink's `CacheRef` (or its below-threshold rehydration, read from the cache) either way, which is exactly why the second copy was redundant. An explicit `shouldAccumulate: true` is still honored, and the default stays "accumulate when uncertain" for every other shape.

**A leaf task is not an opt-out.** `taskNeedsAccumulation` short-circuits on `canStreamBinaryToCache` _before_ it consults the leaf check, and `anyConsumerNeedsMaterialized` is vacuously false for a leaf (it has no consumers). So a cacheable task whose binary ports are its only streaming ports streams them to the cache and returns a `CacheRef` per port whether or not anything is wired downstream, and `accumulateLeafOutputs: true` does not change that. A caller that wants bytes in hand resolves the ref (`resolveOutput` / `resolveJobOutput`) or raises `referenceThresholdBytes` so below-threshold hydration inlines them.

**One writer, two gating rules**: a backing declares exactly one streaming writer, `saveOutputStreamPort(taskType, inputs, port, mode, chunks, metadata)`, probed by `supportsStreaming()`. The binary case is that writer called per binary port with `mode: "binary"`; `CacheCoordinator.getBinaryRefSinksByPolicy` selects those ports and shares one writer closure with the all-mode builder, so the two paths differ in which ports they select, never in how a port's bytes are written. What still differs is when the runner _uses_ the writer, not what a backing has to implement: binary ports stream to the cache unconditionally, while `append` / `object` ports stream only under `noAccumulation`.

**Self-healing dangling refs**: when a ref needed for replay or hydration no longer resolves (blob evicted, cache cleared), the hit converts into a **miss** — the task re-executes and rewrites both the row and the bytes. No events are emitted before all refs are validated.

**A row's refs resolve all-or-nothing.** A row carries one ref per streamed port, so a partially resolvable entry is representable: port A's blob survives an eviction that took port B's. It is never served as one. `CacheCoordinator.replayStreamRefs` resolves _every_ ref before emitting a single event and returns `"miss"` if any one of them dangles, so the caller re-executes and rewrites all ports; the streams that did open are closed first, so no file handle is stranded by the degradation. A half-resolved output — a value at one port and `undefined` at another the row claims has bytes — would be worse than a recompute: the consumer cannot tell that hole from a task that legitimately produced nothing, and nothing downstream would ever report the eviction. Recomputing costs time; the hole costs correctness.

The other two ref-reading paths reach the same guarantee differently, and neither substitutes `undefined` for missing bytes:

- **Input hydration** (`TaskRunner.hydrateInputRefs`) _throws_ rather than missing. By then the bytes were expected to exist and there is no cheaper option to fall back to, so it fails the task with an error naming the port.
- **Below-threshold hydration** (`CacheCoordinator.hydrateRefsBelowThreshold`) leaves an unresolvable ref in place. The port then holds a ref rather than a hole, and the ref fails loudly at the next consumer's input hydration.

The one place a miss does become `undefined` at a port is `resolveOutput` / `resolveJobOutput` — the opt-in, explicitly best-effort resolver an external consumer drives over a completed job's output. It is not on the engine's cache-hit path, and its per-ref behavior is documented on the function.

Refs are validated only when a consumer needs their bytes: with neither consumer hint set, no read is performed and the ref rides out in the finish payload unchecked (that is the "No consumers" row above). Such a ref is not a hole either — it is a pointer whose resolution the caller drives.

**Input-side hydration**: any branded ref that reaches a task's resolved inputs is hydrated against the run's `CacheRegistry` (private first, then deterministic) before validation and cache-key computation, so ref-bearing inputs fingerprint identically to materialized ones. Binary-streaming input ports with a live input stream are skipped — those consumers take bytes from the stream. An unresolvable input ref fails the task with an error naming the port.

**Queue consumers**: `JobHandle.outputStream(port?)` (present only when the `JobQueueClient` was configured with an `outputStreamResolver`, typically `makeJobOutputStreamResolver(repo, schema)`) awaits completion and streams the binary result out of the cache without materializing it; omitting `port` (portless discovery) requires the resolver to have been built with the task's `outputSchema`, which scopes discovery to declared streamable ports — a schema-less resolver rejects portless calls.

**Write ordering: every blob a row points at was already durable.** This is the invariant the whole scheme rests on, and it comes from the order of two writes, not from a transaction:

1. **Blobs during execution.** Each port's sink writes its bytes as they stream and returns a `CacheRef` (`FsFolderTaskOutputRepository.writeSidecar`: write into `<name>.tmp`, `fsync` the handle, atomically `rename` into place, then `fsync` the directory). A partial blob is never publishable — the name only ever appears once the bytes behind it are on disk.
2. **The row afterwards, once.** `CacheCoordinator.save()` issues exactly ONE `saveOutput(...)`, carrying every port's ref inside the serialized output. There is no second row write, and no ref reaches a row before its sink returned.

So a crash anywhere in between leaves orphan blobs and **no row** — a clean miss on the next run, never a row pointing at bytes that do not exist. The reverse failure is the one that cannot happen. Orphans are reclaimed by the age sweep (`clearOlderThan`, which prunes rows by `createdAt` and sidecars by mtime; scheduled via `CacheJanitor`); a synchronous row-write failure additionally triggers a best-effort `deleteOutputByRef` of the blobs just written (`cleanupOrphanBlobsForStreamPorts`), which a hard kill races and the sweep then covers.

`FsFolderTaskOutputRepository` (node/bun) is the production streaming backing: JSON rows via `FsFolderTabularStorage`, bytes as sidecar files under `<folder>/blobs/` written incrementally and published by atomic rename. Two instances over one folder interoperate (the cross-process read story).

**Blob names are unique per write, not lookup keys.** A sidecar is named `<sanitized-taskType>_<input-fingerprint>_<port>_<uuid>.bin` — `mintRefKey` appends a fresh `uuid4()` to every write — so a re-run of the same `(taskType, inputs, port)` publishes a NEW file and **leaks** the previous one until the age sweep reclaims it. That is deliberate: two concurrent writers of the same key land at distinct paths, so neither can half-overwrite the file the other's row already points at, and an orphan-blob cleanup on one writer cannot delete the other's live blob. Nothing looks a blob up by name: lookup is row-first (the `(taskType, inputs)` fingerprint finds the row) and the row's `$ref` names the blob. The sanitized prefix exists to keep names greppable and prefix-deletable, not to identify anything.

**Streaming the private tier.** Streaming is a property of the sidecar, not the tier: `FsFolderTaskOutputRepository` also implements the run-scoped writer (`saveOutputStreamPortForRun`) by folding `runId` into the taskType axis, so the same blob path serves both cache tiers. When the `private` slot's `RunPrivateCacheRepo` wraps such a backing it forwards streaming through that writer (and forwards the opaque by-ref readers), so `kind: "private"` streaming tasks stream end-to-end and `clearRun()` reclaims the run's rows **and** its sidecar blobs by the run's namespace prefix. Wrapping a backing with no sidecar (a tabular run-private table) leaves the wrapper's streaming surface undefined and the private tier degrades to accumulation, exactly as a non-streaming deterministic backing does.

`StreamingIndexedDbTaskOutputRepository` is the durable **browser** streaming backing: JSON rows via `IndexedDbTabularStorage`, port payloads as ordered chunk rows in a dedicated `<dbName>__blobs` IndexedDB database (a `manifest` row per ref witnesses existence and carries `size`/`createdAt`). Writes stream one chunk row per delta (no accumulation); reads page the chunk store so memory stays bounded per chunk. Two instances over one `dbName` interoperate. IndexedDB has no synchronous existence probe, so its by-ref readers are asynchronous — `getOutputStreamByRef` may return a `Promise`, and `streamRefViaBacking` awaits it, so a dangling ref still converts a cache hit into a miss (re-execute) instead of replaying an empty stream. The synchronous filesystem/in-memory readers are unchanged.

The **SQL** backings share one implementation. `TabularBlobChunkStore` persists a ref's bytes as ordered `(refKey, seq, bytes)` chunk rows plus a manifest row over any `ITabularStorage`, keyset-paging the chunk table by `seq` for bounded-memory reads; `TabularStreamingTaskOutputRepository` is the shared base (rows + blob store + `<scheme>://<refKey>` refs). `StreamingPostgresTaskOutputRepository` (server, `bytea` chunks in sibling tables), `StreamingSqliteTaskOutputRepository` (embedded, `BLOB` chunks), and `StreamingSupabaseTaskOutputRepository` (cloud, via PostgREST) are thin subclasses; all read asynchronously through the same widened by-ref contract as IndexedDB.

### Live cross-process stream transport (`onStream`)

`JobHandle.outputStream` (above) streams the _final_ binary result out of the cache after completion. Live **stream events** (`text-delta` / `text-retract` / `object-delta` / `binary-delta` / `snapshot` / `finish` / `phase`) are a separate channel with two serialization boundaries:

- **Worker-thread boundary** (`@workglow/util`): provider run-fns execute inside a worker; `WorkerServerBase.postStreamChunk` posts each event to the main thread. It extracts transferables from the event (mirroring `postResult`), so binary payloads — `binary-delta` buffers and `snapshot` image bytes — transfer zero-copy instead of being structure-cloned; non-binary events yield an empty transfer list and clone byte-for-byte as before. (The same-process `job_stream` fan-out inside `@workglow/job-queue` has no structured-clone boundary — events pass by reference — so transferables are a no-op there.)

- **Cross-process boundary** (`@workglow/job-queue`): by default live events are same-process only — `JobQueueWorker.emitStreamEvent` fires an in-memory `job_stream` event that a `JobQueueServer` forwards to attached clients, and `JobHandle.onStream` is present only on a server-attached handle. A **channel-capable** `IMessageQueue` (one that advertises the optional `publishStreamChunk` / `subscribeToStream`) additionally carries them out of process: the worker best-effort publishes each event (a publish failure never fails the job) and the **carrier** assigns the monotonic 1-based per-job `seq` from a counter it owns — so the sequence is continuous across a retry claimed by a _different_ worker, rather than restarting at 1. A storage-only `JobQueueClient` subscribes per job, orders and de-duplicates rows by `seq` through a `StreamReassembler` — which buffers reordered rows and, once too many pile up ahead of a missing seq, skips the dropped seq so a lost row can't stall the stream or grow the buffer unbounded — resumes from the last delivered `seq` on re-subscribe (no duplicate replay), and dispatches through the same `onStream` machinery. The subscription is torn down when the terminal `finish`/`error` event is delivered; on job completion a grace window defers teardown so a trailing event still in flight on an async carrier isn't dropped. `onStream` is therefore exposed whenever the server **or** the queue's stream channel can deliver, and behaves identically regardless of transport. On a channel-capable queue, server-attached clients subscribe to the channel too — on a shared queue the job may be claimed by a worker in another process, which the in-memory fast path can never observe — and while a job's subscription is open the channel is authoritative and the fast path is suppressed for it (no double-delivery); on a channel-less carrier, server-attached clients keep the direct in-memory fast path. Deterministic re-dispatch is unaffected: the channel is a pure observation side-stream that never influences claim / execution / retry, and a queue with no channel degrades to today's "no live stream cross-process".

`InMemoryQueueStorage` is the reference carrier — a per-job ordered append log plus live subscribers and a carrier-owned per-job `seq` counter, with `seq > sinceSeq` replay for late or reconnecting subscribers and eviction of a job's stream (log, subscribers, and counter) on row deletion. Durable cluster carriers (Postgres `LISTEN/NOTIFY` signalling a `(job_id, seq, bytes)` chunk table, since NOTIFY payloads are size-capped; Supabase Realtime), the IndexedDB cross-tab `BroadcastChannel` carrier, and the base64 binary row serialization those durable carriers require are a follow-up.

### Per-port stream sinks and the no-accumulation passthrough

Everything above generalizes from "binary ports only" to **every delta stream mode**
(`append`, `object`, `binary`) behind an opt-in run flag,
`TaskGraphRunConfig.noAccumulation` (default off — off is byte-identical to the
accumulation path).

**Per-port sinks (cache as tee).** When the flag is on, the task is cacheable,
and the cache backing implements the port-aware stream writer
(`saveOutputStreamPort`, advertised via `supportsStreaming()`), the runner
builds one `StreamSink` per streaming output port. `StreamProcessor` encodes
each port's deltas through that mode's codec (`append` → UTF-8 text, `object` →
NDJSON delta log, `binary` → identity bytes) and routes the bytes to the sink
instead of buffering them into an enriched finish event. Each port's slot in the
returned output carries its own `CacheRef`; the cached row stores those refs
(wire form), and below-threshold hydration to inline values applies to the value
returned to the caller, as on the binary path. Backings without
`saveOutputStreamPort` — inline-only backings — never see this path: the task
falls back to accumulation and its outputs are cached inline as before.

**Skippable edge materialization.** An edge qualifies as a _passthrough edge_
when the flag is on, the edge carries a live stream with no transforms, source
and target ports declare the **same** delta stream mode, the target is itself a
streamable task (it implements `executeStream`; only streamable tasks receive
`ctx.inputStreams`) without a subgraph, the source port has exactly **one**
consumer, and the target port does not set `x-validate-stream: true`. Such an
edge skips the full-speed materialize drain entirely: the consumer takes its
data from the live event stream (handed to its `executeStream` via
`ctx.inputStreams`, without a tee — nothing else will read the edge), and the
edge's settled value is set from the producer's result when it finishes (the
per-port `CacheRef`, or the inline value a below-threshold ref was rehydrated
to). Every non-qualifying edge — transforms, mode mismatch, fan-out, `*`
edges, non-streamable or subgraph targets — falls back to today's drain, which
is correct, just without the memory and pacing win.

**Caching a stream-fed consumer.** A consumer reading a live stream computes
its cache key while the streamed port is unsettled (`CacheRef` or nothing in
the slot), so the streamed content cannot contribute to the key. Rather than
let two runs that differ only in stream payload collide on one cache entry,
the runner disables caching (`kind: "none"`) for any run consuming a live
stream at an unsettled port. Drained edges settle the value before key
computation and keep caching as usual.

**Validation of stream-wired inputs.** Whole-value input validation is a
settled-value concept, and a stream-wired port has no settled value while the
stream is live — its static slot holds a `CacheRef` (or nothing) until finish.
The runner therefore exempts such a port from validation when (and only when)
its slot is a ref or `undefined`; a port that already carries a materialized
value is validated as usual. A target port can opt back in with
`x-validate-stream: true`, which also disqualifies its edge from the
passthrough so the drain materializes a validatable value.

**All-mode backpressure.** On a passthrough edge the producer is paced to the
consumer's read rate by a per-port `BackpressureGate` owned by the graph
runner: each event enqueued onto the edge stream charges the gate with its
`streamEventCost` (UTF-8 bytes for text deltas, JSON-encoded length for object
deltas, raw byte length for binary), and each event the consumer reads credits
it back. After emitting a delta, `StreamProcessor` awaits the gate for that
port (threaded down as `IRunConfig.edgeBackpressure`, so the task layer stays
edge-agnostic); once buffered cost reaches the high-water mark —
`TaskGraphRunConfig.streamHighWaterBytes`, defaulting to the binary router's
8 MiB — the producer parks until the consumer drains below the mark. Producer
completion, abort, error, and consumer termination all close the gate, so a
parked producer can never be orphaned. A gate is built only when the consumer
can make read progress while the producer is parked: if any OTHER edge into
the consumer is sourced from the producer or one of its descendants (a drained
edge, a mode-mismatched edge, a static-value edge), that edge settles only
after the producer finishes, so gating would deadlock the pair — such
consumers keep the ungated passthrough (correct, just unpaced). Tasks that
emit through a side channel can cooperate explicitly via `ctx.backpressure()`,
which awaits both the cache-sink routers and every edge gate.

**Producer failure mid-stream.** A producer FAILURE (not abort) enqueues an
in-stream error event on every attached edge stream before closing it, so a
drained edge materializes the failure — a consumer already dispatched
(unblocked at STREAMING) fails with the producer's error instead of
completing, and caching, an output derived from truncated input. Abort keeps
the graceful close: the run-level abort cascade is already tearing everything
down.

**Fan-out limitation.** Precise pacing is single-consumer by design. A source
port feeding two or more consumers keeps the tee'd drain: every consumer still
receives all events in order, but pacing is best-effort — no gate bounds the
producer's lead.

**Cache hit ≡ fresh run.** On a cache hit for a task with per-port refs and a
same-mode streaming consumer, the runner replays each port's cached bytes
through the mode's codec as delta events, so downstream tasks observe the same
event sequence as a fresh run. Replay honors the same consumer-edge gate as a
fresh run (each emitted delta awaits `edgeBackpressure`); ungated consumers
replay at read speed. Materializing consumers receive hydrated values in the
enriched finish event, exactly as on the binary path.

### Durable execution model

A run is an atomic unit on a single worker. When the worker crashes:

1. Builder (or whatever scheduler dispatched the run) detects the crash via heartbeat / timeout.
2. The same job is re-dispatched **with the same `runId`** to a (possibly different) worker.
3. The new process constructs a fresh in-memory scheduler, but the durable `private` repo still holds every task output that completed before the crash.
4. The runner re-traverses the DAG from scratch; cache hits skip completed work, cache misses execute.

The runner emits a one-time startup warning if any task in the graph declares `kind: "private"` and the registered `private` repo reports `isDurable() === false`. The detection is a repo capability flag, not a registration check — in-memory backings, ephemeral wrappers, and test doubles all surface as non-durable.

#### What durable execution does **not** cover

- **Mid-graph checkpointing of in-flight scheduler state.** Crashed runs re-execute from scratch; the cache absorbs completed work. There is no resumption of a single in-flight task.
- **Streaming partial outputs.** A task that crashed mid-stream re-executes from scratch on restart; only fully completed tasks become cache hits.
- **Splitting one run across multiple workers.** A run is atomic on one worker.

### Re-dispatch correctness invariant

Re-execution must produce the same DAG traversal given the same inputs and cache state. Task ordering, parallelism limits, and scheduling decisions in `RunScheduler` must not depend on wall-clock time, machine identity, or worker-local random state. Today's scheduler satisfies this; the model treats it as a maintained invariant.

---

## Dataflow and Input Propagation

### How Data Flows Between Tasks

```
TaskA (source)                    TaskB (target)
    ↓                                 ↓
outputSchema: {                  inputSchema: {
  result: number                   value: number
}                                }
    ↓                                 ↓
Dataflow("taskA", "result", "taskB", "value")
    ↓
TaskA.runOutputData.result → TaskB.runInputData.value
```

### Key Methods

| Method                                    | Purpose                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `copyInputFromEdgesToNode(task)`          | Pull data from all incoming dataflows into task's `runInputData` |
| `pushOutputFromNodeToEdges(task, output)` | Push task's output to all outgoing dataflows                     |
| `addInputData(task, data)`                | Merge data into task's `runInputData`                            |

### When Input is Copied

| Execution Path | Task Status | Input Copied?             |
| -------------- | ----------- | ------------------------- |
| `run()`        | Any         | Yes (always)              |
| `runPreview()` | PENDING     | Yes                       |
| `runPreview()` | COMPLETED   | **No** (output is locked) |

---

## GraphAsTask (Subgraphs)

### What is GraphAsTask?

A `GraphAsTask` is a task that contains an internal `TaskGraph` (subgraph). This enables:

- Hierarchical workflow composition
- Encapsulation of complex logic
- Reusable workflow components

### Execution Flow

```
GraphAsTask.run(input)
    ↓
GraphAsTaskRunner.executeTask(input)
    ↓
executeTaskChildren(input)
    ↓
subGraph.run(input)      # Execute the entire subgraph
    ↓
mergeExecuteOutputsToRunOutput()  # Combine results from ending nodes
```

### Preview Execution with Subgraphs

```
GraphAsTask.runPreview(input)
    ↓
GraphAsTaskRunner.executeTaskPreview(input)
    ↓
executeTaskChildrenPreview()
    ↓
subGraph.runPreview(this.task.runInputData)  # ← IMPORTANT: Pass parent's input
    ↓
mergeExecuteOutputsToRunOutput()
```

**Critical:** The parent's `runInputData` is passed to `subGraph.runPreview()` so that root tasks in the subgraph (like InputTask) receive the input values.

### Root Task Input Propagation

In `runGraphPreview()`:

```typescript
const isRootTask = this.graph.getSourceDataflows(task.id).length === 0;

// For root tasks, pass the input parameter (from parent GraphAsTask)
const taskInput = isRootTask ? input : {};

const taskResult = await task.runPreview(taskInput);
```

This ensures:

1. Root tasks (no incoming dataflows) receive input from the parent
2. Non-root tasks receive input from their upstream dataflows

---

## Key Invariants

### 0. Cycle Guarantees

- `TaskGraph` is a `DirectedAcyclicGraph`. The underlying `TaskGraphDAG` extends `DirectedAcyclicGraph` from `@workglow/util/graph`.
- `TaskGraph.addDataflow` throws `CycleError` **synchronously** whenever the new edge would close a cycle. Detection runs inside `DirectedAcyclicGraph.addEdge` via `wouldAddingEdgeCreateCycle`, so no graph can ever reach a cyclic state — cycles are rejected at the construction call, not at run time.
- Loop tasks (`WhileTask`, `IteratorTask`, `MapTask`, `ReduceTask`) achieve repetition by re-running an internally-acyclic subgraph once per iteration, never by adding back-edges. Each subgraph is its own `TaskGraph` and inherits the same invariant. `GraphAsTask.validateAcyclic()` re-asserts the invariant when the subgraph is finalized, so any direct `_dag` manipulation is caught before execution.

### 1. COMPLETED Tasks Are Immutable

Once a task's `run()` completes and status becomes `COMPLETED`:

- `runOutputData` is **locked** and **cacheable**
- `runInputData` should not be modified
- `runPreview()` returns the cached output unchanged (does not invoke `executePreview()`)

### 2. Only PENDING Tasks Receive Dataflow Updates in Preview Mode

```typescript
if (task.status === TaskStatus.PENDING) {
  task.resetInputData();
  this.copyInputFromEdgesToNode(task);
}
```

### 3. Root Tasks Receive Parent Input

In subgraphs, root tasks (no incoming dataflows) receive the parent's input:

```typescript
const taskInput = isRootTask ? input : {};
task.runPreview(taskInput);
```

### 4. executePreview is Lightweight

The `executePreview()` method should:

- Complete quickly (< 1ms ideally)
- Not perform heavy computation
- Return UI preview data (or `undefined` to leave the prior output unchanged)

Heavy computation belongs in `execute()`.

### 5. Preview Execution Respects Task Order

Tasks are executed in topological order (via the preview scheduler), ensuring:

- Upstream tasks run before downstream tasks
- Data is available when needed

### 6. run() and runPreview() Are Strictly Separate

`run()` never invokes `executePreview()`. `runPreview()` never invokes `execute()` or `executeStream()`. There is no overlay, no merge, and no second hidden stage. Cache hits during `run()` return the cached value verbatim.

A task that overrides `executePreview()` but not `execute()` throws `TaskConfigurationError` on its first `run()` call. Implement `execute()` to fix this — typically by extracting a shared helper called by both methods.

---

## Common Pitfalls

### 1. Modifying COMPLETED Task Input

**Wrong:**

```typescript
// Trying to update a COMPLETED task's input
task.setInput({ newValue: 42 }); // ❌ Violates immutability
```

**Correct:**
Only modify input for PENDING tasks, or reset the entire graph first.

### 2. Missing Root Task Input Propagation

**Wrong:**

```typescript
protected async executeTaskChildrenPreview() {
    return this.task.subGraph!.runPreview();  // ❌ No input passed
}
```

**Correct:**

```typescript
protected async executeTaskChildrenPreview() {
    return this.task.subGraph!.runPreview(this.task.runInputData);  // ✓
}
```

### 3. Copying Input to COMPLETED Tasks

**Wrong:**

```typescript
// In runGraphPreview
this.copyInputFromEdgesToNode(task); // ❌ Always copies, even for COMPLETED
```

**Correct:**

```typescript
if (task.status === TaskStatus.PENDING) {
  task.resetInputData();
  this.copyInputFromEdgesToNode(task); // ✓ Only for PENDING
}
```

### 4. Heavy Computation in executePreview

**Wrong:**

```typescript
async executePreview(input) {
    // ❌ Takes 30 seconds
    const result = await this.trainNeuralNetwork(input);
    return { result };
}
```

**Correct:**

```typescript
async executePreview(input) {
    // ✓ Quick preview (< 1ms)
    return { preview: this.quickPreview(input) };
}

async execute(input) {
    // Heavy work belongs here
    const result = await this.trainNeuralNetwork(input);
    return { result };
}
```

### 5. Implementing only executePreview()

**Wrong:**

```typescript
class MyTask extends Task {
  // ❌ Only override executePreview
  async executePreview(input) {
    return { result: input.value * 2 };
  }
}
```

`run()` will throw `TaskConfigurationError` because there is no `execute()` to call.

**Correct:** Extract a shared helper and call it from both methods:

```typescript
function double(value: number): number {
  return value * 2;
}

class MyTask extends Task {
  async execute(input) {
    return { result: double(input.value) };
  }

  async executePreview(input) {
    return { result: double(input.value) };
  }
}
```

---

## Summary

| Aspect               | `run()`                            | `runPreview()`     |
| -------------------- | ---------------------------------- | ------------------ |
| **Purpose**          | Full execution                     | UI previews        |
| **Method called**    | `execute()` (or `executeStream()`) | `executePreview()` |
| **Calls preview?**   | Never                              | n/a                |
| **Calls execute?**   | n/a                                | Never              |
| **Final status**     | COMPLETED                          | Unchanged          |
| **Output**           | Locked/cached                      | Temporary          |
| **Dataflow updates** | Always                             | Only PENDING tasks |
| **Performance**      | Can be slow                        | Should be < 1ms    |
| **User edits**       | Before run starts                  | Before run starts  |

### Key Takeaways

1. Users only edit inputs on PENDING tasks
2. Once `run()` completes, the task is COMPLETED and immutable
3. `runPreview()` propagates lightweight updates through PENDING tasks
4. COMPLETED tasks return cached results in preview mode
5. Root tasks in subgraphs receive input from the parent GraphAsTask
6. `run()` and `runPreview()` are strictly separate — no overlay, no merge, no second stage
