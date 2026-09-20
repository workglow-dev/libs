<!--
  @license
  Copyright 2026 Steven Roussey <sroussey@gmail.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Threaded Subgraphs

## Overview

A compound task — `GraphAsTask`, or an `IteratorTask` / `MapTask` iteration —
can run its subgraph on another thread, so one graph uses more than one core.
Everything crosses as data: the subgraph is serialized to `TaskGraphJson`,
rebuilt on the far side through that thread's own task-constructor registry,
and its results come back as ordinary per-leaf outputs.

Three pieces make it up, each usable on its own:

- a **portability gate** that answers, without throwing, whether a graph can
  be rebuilt elsewhere;
- a **dispatcher contract** (`ISubGraphDispatcher`) describing a subgraph run
  as data, with a worker-backed implementation over `WorkerManager`;
- **credit-window backpressure** in the worker protocol, which is what lets a
  streaming port cross the boundary without the stream buffering without bound.

Opting in is one config property. Everything else is a fallback: a graph must
produce the same result on a host that never set a worker up.

## Opting in

```ts
// Per iteration of a map
const loop = wf.map({ concurrencyLimit: 4, maxIterations: "unbounded", concurrencyMode: "thread" });
loop.pipe(new SomeRegisteredTask());
loop.endMap();

// Or for a whole compound task
new GraphAsTask({ subGraph, executionMode: "thread" });
```

Both default to `"inline"`. `IteratorTaskRunner` and `GraphAsTaskRunner` ask
the same question through `threadDispatcherFor(graph, mode)`, which lives on
`GraphAsTaskRunner` and is inherited by the iterator.

An off-thread run happens only when all three hold, and **each failure falls
back in-process with the reason logged** rather than throwing:

1. the mode asks for it,
2. a `SUBGRAPH_DISPATCHER` is registered on the run's `ServiceRegistry`,
3. `taskGraphThreadPortabilityError(graph, registry)` returns `undefined`.

The log matters: "my threaded map is not using cores" is otherwise invisible —
the run simply stays slow.

## Thread portability

`taskGraphThreadPortabilityError(graph, registry?)` returns the first problem
as a sentence naming the offending task, or `undefined`. It walks nested
subgraphs and checks two independent things.

**It serializes.** `Task.originalConfig` is a `structuredClone` of the config
taken at construction, left `undefined` when that clone throws;
`canSerializeConfig()` is the task's own declaration on top of it. Either
failing means `toJSON` throws, so the task cannot be described to the far side
at all. `LambdaTask` is the pure case; `WhileTask` and `ConditionalTask` are
conditional on whether their condition arrived as a function or as declarative
config.

**Its type is registered.** Serializing says nothing about whether the far side
can rebuild it. This is the half serialization cannot see, and it catches the
most common real failure: `pipe(fn)` mints a fresh anonymous subclass per call
(`createPipeFunctionTask`) whose `type` is derived from the function name and
whose closure lives in the class body, not in config. Config is empty and
plain, so `canSerializeConfig()` is true, the clone succeeds, `toJSON()`
succeeds — and the JSON names a type no registry has ever heard of. A subgraph
whose body is a piped function is not portable, and the gate says so by name.

The check is made against the registry the **receiver** will rebuild through,
which is normally not the host's: see [Two registries](#two-registries).

Two hazards it deliberately does not cover: `task.config` is mutable while
`toJSON` reads the frozen `originalConfig`, so a post-construction mutation
crosses invisibly (in-process `cloneGraph` has the same blind spot); and
portable is not the same as advisable — a graph of fetch tasks is perfectly
portable and still belongs on the thread that owns the rate limiter.

## The dispatcher contract

```ts
interface SubGraphRunRequest {
  readonly graph: TaskGraphJson;
  readonly input: TaskInput;
}

interface ISubGraphDispatcher {
  runSubGraph(request, options?): Promise<SubGraphRunResults>;
  runSubGraphStream?(request, options?): AsyncIterable<SubGraphStreamItem>;
}
```

A request is only what survives `structuredClone`. A dispatcher returns **raw
per-leaf results** (`{ id, type, data }` per leaf), never a merged output:
merging is `mergeExecuteOutputsToRunOutput(results, compoundMerge)` and
`compoundMerge` is a static on the parent's class, so sending it would mean
serializing a merge strategy and trusting the far side to apply the same one.
The parent merges, exactly as for an in-process run.

`runSubGraphRequest` / `runSubGraphStreamRequest` are the receiving half —
rebuild from the receiver's registry, run, return — and a worker entry
registers them through `registerSubGraphWorker()`.

`WorkerSubGraphDispatcher` is the `WorkerManager`-backed implementation, and is
deliberately thin: the manager already owns lazy construction, idle eviction,
request correlation, progress, abort, and error rehydration. A retry or pool
policy belongs there, where every worker caller benefits.

## Streaming across the boundary

A message port has no natural backpressure — `postMessage` always accepts — so
a worker outrunning its consumer does not slow down, it relocates its backlog
into the caller's heap. Credit-window flow control is what fixes that:

- `BackpressureGate` (in `@workglow/util`, since the worker protocol sits
  upstream of `task-graph`) is the cost-agnostic park/wake primitive.
- `streamChunkCost` approximates an item's cost structurally — bytes for
  binary, characters for text, one per item otherwise, never zero.
- `WorkerServerBase` keeps a per-request gate when the call carries a
  `creditWindow`, and `emit` returns a promise so a run-fn can `await` it and
  be paced. An abort releases a parked producer, which is waiting on a credit
  the caller stopped sending rather than on the signal.
- `WorkerManager.callWorkerRunFunction` takes `creditWindow` and credits once
  the consumer's emit settles — credited even if the consumer throws, or a
  refusal to consume would strand the producer on a window that never reopens.

**Opt-in throughout.** Without a `creditWindow` the behaviour is exactly what
it was: a caller on the older protocol sends no credits, so an unconditional
gate would park the producer forever.

`GraphAsTask.executeStream` is where a streaming port actually crosses. It
needed no new machinery, because `executeStream` is a generator consumed by
`StreamPump` and a generator is pull-paced by whoever consumes it:

```
downstream read → generator resumes → handoff channel pull
    → credit posted → worker's gate releases → next chunk
```

The edge tee, materialization and `noAccumulation` behaviour are unchanged —
the wrapper yields the same `StreamEvent`s it always did, sourced from a worker
instead of a local subgraph. `StreamEvent` already names its `port`, so nothing
extra was needed to route a chunk to the right edge.

`threadStreamDispatcherFor` additionally requires `runSubGraphStream` on the
dispatcher. One that cannot stream would buffer the whole subgraph output and
hand it over at the end, which is the opposite of what a streaming port is for,
so such a group stays in-process where its stream is real.

## Two registries

`TASK_CONSTRUCTORS` is a service token and `getTaskConstructors(registry)`
resolves per-registry, falling back to the global `TaskRegistry`. A worker
binds the full constructor map in **its own** `ServiceRegistry`; the host's
stays whatever it curates for its CLI surface. "Types this thread can rebuild"
and "tasks a human may invoke by name" are different questions, and this is
what keeps one from being forced to answer the other.

## Wiring a worker

Libs ships both endpoints; the entry is the application's, because only it
knows what to bring up and which tasks to register.

```ts
// worker/subgraph-worker.ts
import "@workglow/util"; // side-effect: registers the platform WorkerServer
import { registerSubGraphWorker } from "@workglow/task-graph";

const registry = await bootstrapRuntime();  // app's own: env, DB, models
registerFullTaskConstructors(registry);     // the rebuild map
registerSubGraphWorker(registry);
```

```ts
// host, once at startup
globalServiceRegistry.get(WORKER_MANAGER).registerWorker(
  "subgraph",
  () => new Worker(new URL("./worker/subgraph-worker.js", import.meta.url), { type: "module" }),
  { idleTimeoutMs: 30 * 60_000 }
);
globalServiceRegistry.registerInstance(
  SUBGRAPH_DISPATCHER,
  new WorkerSubGraphDispatcher("subgraph")
);
```

Worker startup is seconds, not milliseconds — a worker runs the application's
whole bootstrap. The pool must be long-lived and shared; an `idleTimeoutMs`
shorter than the gap between runs pays that cost again every time, and whatever
disposes workers at exit must drain this pool too or the process hangs after
printing its results.

## What crosses, and what does not

`SubGraphRunRequest.runOptions` carries the serializable slice of the run
config — `enforceEntitlements`, `noAccumulation`, `streamHighWaterBytes`,
`streamGateWatchdogMs` — built in one place (`serializableRunOptions()`) so the
three dispatch sites cannot drift. It has to cross, or a subgraph would run
under different semantics purely because it ran elsewhere: silently unenforced
entitlements, or a streaming edge that accumulates on one thread and passes
through on another.

The rest of a run config is live objects and stays behind:

| Dropped | Consequence |
| --- | --- |
| `outputCache` | a dispatched subgraph runs against whatever cache the receiving registry binds, or none |
| `resourceScope` | per-thread; the receiver disposes its own |
| `usageSink` / `lateUsageSink` / `usageRetireSink` | token accounting for a dispatched subgraph does not reach the host's sinks |

A worker that should share the host's cache binds its own repository over the
same store. One that binds nothing runs uncached — correct, slower, never
wrong. The usage sinks are the sharpest of the three: cost math over a run with
dispatched subgraphs undercounts unless the worker reports separately.

## The event bridge

`bridgeSubGraphTaskEvents` re-emits a subgraph's per-task events onto its
parent in-process, and a dispatched subgraph forwards exactly the same six —
`task_complete`, `task_progress`, `task_stream_start`, `task_stream_chunk`,
`task_stream_end`, `task_usage` — as `{ kind: "event" }` items on the stream.
`GraphAsTask.executeStream` replays them with `parentGraph.emit(name, ...args)`.

Carried as a name plus already-serializable arguments rather than a typed
union per event: the host replays them positionally, and giving each one a
shape here would be a second definition of the event surface to keep in step.

Without this a dispatched group collapses to one opaque row in a progress UI,
its children invisible — which is how it behaved before, and why a threaded
run looked like a stall.

## Backpressure, and where it stops

On the streaming path the pacing is complete, because `executeStream` is a
generator consumed by `StreamPump`: the downstream read rate reaches back
through the handoff channel and the credit window to the worker's gate.

Forwarding inside the worker is a different matter. `StreamPump` emits
`task_stream_chunk` **synchronously**, so a forwarding listener cannot park its
producer — awaiting inside a listener does not stop an emitter. What it can do
is refuse to grow: forwarded-but-unconsumed cost is tracked against
`forwardBufferLimit` (default 8 MiB), and past it the run fails with
`SubGraphForwardOverflowError` naming the pending cost and the ceiling.

That is a deliberate trade. A subgraph that persistently outruns its consumer
used to consume the worker's heap silently; now it fails with something a
reader can act on. Genuine parking would mean draining the leaf's edge stream
rather than subscribing to the graph's event, which is a larger change to
`StreamPump` than this boundary warrants.

## Boundaries

- **No worker is spawned by libs.** Registration is the application's.
- **Live run state does not cross** — see
  [What crosses, and what does not](#what-crosses-and-what-does-not). Token
  accounting is the sharpest: usage sinks stay behind, so cost math over a run
  with dispatched subgraphs undercounts unless the worker reports separately.
- **A crashed worker is the task throwing.** No retry, no special case: the
  dispatch rejects and the failure travels the path a thrown task already
  takes, so an `IteratorTask` iteration fails as an iteration and a
  `GraphAsTask` fails as a task.

  This needed `WorkerManager` to reject in-flight calls on the worker's `error`
  event. It previously only logged, so a thread that died answered nothing and
  its caller waited forever — an outcome with no stack, no message and no end,
  and strictly worse than either retry policy. All three call paths (plain,
  stream, run) now detach their crash listener in the request's own cleanup, so
  a long-lived worker accumulates none.
