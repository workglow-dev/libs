# @workglow/task-graph

## 0.6.3

_No changes in this package._

## 0.6.2

_No changes in this package._

## 0.6.1

_No changes in this package._

## 0.6.0

### Features

#### task-graph,ai

- a tool call's whole life on the wire (#936)

## 0.5.1

### Features

- chat agent utilities (#929)

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

#### task-graph

- add entitlement approval gate for ai task classes (#923)

### Bug Fixes

#### task-graph

- move `runPreview`'s return out of the `finally` block (#918)

#### web-search

- name a credential for a provider, fill Brave's open date bound, and thread abort
- resolve the search credential once, in the task that sends it

### Chores

- revert version change not made by bunset

## 0.4.9

### Bug Fixes

- not sure why vitest peerdep on taskgraph

### Chores

#### deps

- upgrade Vitest to 5

## 0.4.8

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

### Features

#### interpreter

- enhance TypeScript definitions for interpreter functionality

#### task

- implement entitlement enforcement in TaskRunner and TaskGraphRunner
- enhance GraphAsTask and GraphAsTaskRunner with entitlements support

### Bug Fixes

#### task-graph

- give a streaming subgraph the run's resource scope

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

## 0.3.46

### Features

#### triggers

- add the triggers package with cron, interval, and polling triggers

### Bug Fixes

#### storage

- scope InMemory column constraints to a backend mode and document the nullable-column DDL change

#### task-graph

- let a standalone binary-only run skip the accumulator too (#822)

## 0.3.45

### Breaking Changes

- **bug fixes(task-graph)**: stop clearRun dangling blob refs; restore the publish test gate (#793)
- **refactors(task-graph)**: always return a Promise from getOutputStreamByRef

### Features

#### task-graph

- publish the run's resolved cache on IExecuteContext
- recognize stream-consuming sink tasks
- stream N binary output ports to cache on the unflagged path

### Bug Fixes

#### task-graph

- cover the co-located tests the Promise collapse missed
- re-resolve credential inputs on a re-run instead of blanking them (#799)
- stop clearRun dangling blob refs; restore the publish test gate (#793)
- run a pure stream consumer through the stream pump
- restore force-accumulate protection for leaf tasks
- gate force-accumulate on materializing consumers, not streaming ones
- a non-cacheable task ignores the cache when deciding accumulation
- add missing override modifier in multi-binary port test

### Refactors

#### task-graph

- always return a Promise from getOutputStreamByRef

#### tasks

- pin response_type at every call site

### Performance

#### task-graph

- delete a run's private cache rows by name, not by scanning

### Tests

#### task-graph

- pin the undeclared-executeStream warning as reachable
- pin the streaming memory bound
- resolve accumulation test through the package entry
- pin the no-sink-and-no-accumulator hole for multi-binary tasks
- pin the all-or-nothing multi-port cache-ref invariant

### Documentation

#### task-graph

- document cache write ordering, correct the blob-name claim
- state the ICacheRef.port writer guarantee, and test it

## Unreleased

### Breaking Changes

- **refactor(task-graph)**: `TaskOutputRepository.getOutputStreamByRef` (and
  `getOutputStreamByRefForRun`) always return a Promise

  Both were declared as a tri-state union —
  `AsyncIterable<Uint8Array> | undefined | Promise<AsyncIterable<Uint8Array> | undefined>` —
  which does not compose with `StreamPortCodec.materialize`, whose parameter is the
  iterable alone. Every consumer had to decide for itself whether a given backing needed
  awaiting, and the tree had grown two narrowings of the one interface in opposite
  directions: the concrete repositories overrode it with the synchronous half, while the
  streaming contract helper declared its own Promise-only version.

  The union also made the await in `streamRefViaBacking` load-bearing by convention
  rather than by type. That await is what turns an asynchronous backing's dangling ref
  into `undefined` — a cache miss — instead of a truthy Promise a caller reads as a live
  stream, and nothing in the signature required it.

  Migration for an implementor: mark the method `async`. A backing that can answer
  synchronously still does; the cost is one microtask per ref, not per chunk. Callers
  that were relying on the synchronous return must `await` it — including in assertions,
  where `expect(repo.getOutputStreamByRef(ref)).toBeDefined()` previously passed for a
  dangling ref, because a Promise is always defined.

## 0.3.44

### Bug Fixes

#### task-graph

- stop caching ConditionalTask and cover unfed branch ports
- derive branch ports for conditionConfig-driven ConditionalTask

## 0.3.43

### Breaking Changes

- **refactors(task-graph)**: collapse the dual streaming writer surfaces

### Refactors

#### task-graph

- collapse the dual streaming writer surfaces

## 0.3.42

## 0.3.41

### Bug Fixes

#### task-graph

- drop the owned-sink stamp on disown

## 0.3.40

### Features

#### cli

- add tests for live iteration graphs in WorkflowRunApp

### Bug Fixes

#### task-graph

- reject own() config for an already-constructed task

## 0.3.39

### Features

- add tests for task usage duration and enhance usage line handling

#### web-example

- show the run's cumulative token total

#### task-graph

- add an opt-in run-usage recorder
- report a cache hit as a stated zero cost
- aggregate token usage per run
- add a task-level usage event
- fold mid-stream usage snapshots without double-counting
- add the mid-stream usage event
- ship InMemoryTaskOutputRepository from ./test

### Bug Fixes

- improve usage tracking
- usage tracking for owned subtasks in Task Graph

#### ai,task-graph

- keep heuristic usage estimates out of accounting

#### task-graph

- count an owned child's late charge once
- scope usage sinks to the run that supplied them
- drop the run_usage columns nothing can populate
- roll usage up by task and by model, not one slice each
- count a nested task's spend once, not once per hop
- break the Task/ConditionalTask module cycle
- detach the run's usage listeners at run end
- reset the usage aggregator per run instead of replacing it
- key usage buckets without string collision
- defer the pipe-function wrapper past the Task cycle

#### task-graph,ai

- route a checkpoint's storage charge into the run total

#### test

- satisfy typecheck:tests across the usage test helpers
- close the gaps the Turbo/projects wiring opened

#### util

- last complete object wins when skipping JSON preamble (#718)

### Refactors

- decompose BaseTabularStorage.ts and Task.ts along functional seams (#682)

#### task-graph

- name run-usage columns like every sibling schema

#### test

- drop the FsFolderTaskOutputRepository shim

### Tests

- run tests through Turbo and per-package vitest projects
- move 174 more unit tests into their owning packages
- discover test files instead of enumerating sections

#### task-graph

- cover the cache-hit usage emit
- cover usage survival on aborted and finish-less streams
- make the StreamUsage type assertion actually enforceable
- relocate the remaining task-graph test infrastructure
- move TestTasks into the package's ./test entry
- extract the streaming task-output repository contract

#### ai

- pin the Usage field contract and assert disjointness

### Chores

- upgrade to catalog for many deps and update the deps themselves

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

### Features

#### task-graph

- implement runId-scoped ref readers on FsFolder
- add optional *ForRun ref methods to TaskOutputRepository
- allow async getOutputStreamByRef for non-filesystem backings
- stream the run-private cache tier over an FsFolder backing
- backpressure gate on the no-accumulation passthrough edge
- cache-hit replay parity for non-binary refs (Task 6)
- no-accumulation passthrough — skip the materialize drain
- exempt stream-wired input ports from whole-value validation
- thread noAccumulation run flag to the streaming seam
- generalize stream sinks to all modes (per-port refs)
- per-mode stream codecs + port-aware repo stream sink
- add optional port/mode axis to CacheRef
- FsFolderTaskOutputRepository with streaming blob sidecar files
- hydrate cache refs in task inputs before execute
- cache-hit replay and hydration of binary cache refs
- expose binary stream-consumer detection for cache-hit replay
- resolveJobOutputStream for streaming job results from cache
- streaming read helpers for cache refs
- binary-streaming framework + result-as-reference

#### test

- Supabase streaming cache backing

#### ai

- add a uniform usage telemetry channel

### Bug Fixes

- restore branch-final content drifted during the rebase onto main

#### task-graph,util

- close storage and worker review findings

#### job-queue

- close stream-channel review findings
- harden the cross-process stream channel

#### task-graph

- close streaming engine review findings
- fail passthrough edge gates on abort and enforce watchdog liveness
- make BinaryStreamRouter push/end race-safe
- restrict portless outputStream discovery to declared streamable ports
- reject same-backing CacheRegistry misconfiguration at run start
- netstring-encode runScopePrefix to close sanitize collision
- route RunPrivateCacheRepo by-ref through *ForRun to prevent cross-run leak
- correctness fixes from branch-wide streaming review
- replace-mode streams must carry a value, else error
- stamp FsFolder blobs with unique suffix to prevent orphan-cleanup races
- fsync blobs directory after rename to survive crashes between rename and dir-metadata flush
- treat all class instances as opaque in ref walker
- document single-tenant assumption of FsFolderTaskOutputRepository deterministic tier
- clean up orphan blobs when stream-write succeeds but row commit fails
- fsync blob temp handle before rename in FsFolderTaskOutputRepository
- treat Error and URL as opaque leaves in ref walker
- guard resolveOutput walker against cycles and shared subtrees
- default blob/binary port codecs for JSON-row cache backings
- cache rows store refs, not inline binary; enforce single-binary-port streaming
- blob lifecycle hardening in FsFolderTaskOutputRepository
- byte-bounded backpressure in binary stream router (default 8 MiB)
- canonicalize binary stream format vocabulary to "blob"|"binary"
- brand CacheRef with literal kind to prevent shape-only collisions

### Refactors

#### task-graph

- extract BackpressureGate from BinaryStreamRouter
- remove dead pipeBinaryToCache; detach edge-stream listeners on abort/error

### Documentation

#### task-graph

- document live cross-process stream transport
- document tabular SQL streaming cache backings
- document IndexedDB streaming cache backing
- document binary cache stream-out in EXECUTION_MODEL

## 0.3.37

### Features

#### dataUri

- implement dataUriToBlob function for decoding data URIs to Blobs

### Bug Fixes

- data-URI decode order, own() tracking for functions, UI wiring
- bound CLI listener retention, reject double-own, decode binary data URIs

## 0.3.36

## 0.3.35

### Features

#### task-graph

- add context.disown so owners can release finished subtasks

## 0.3.34

### Features

#### cli

- show the work inside an owned workflow, not just its wrapper row
- label task rows by instance title, not class type

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

#### task-graph

- update cache imports for better organization

## 0.3.23

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

#### task-graph

- update cache imports for better organization

### Chores

- format / lint

## 0.3.22

### Bug Fixes

#### review

- resolve xhigh code-review findings on cherry-picked 601+604

#### task-graph/cache

- require liveRunIds callback and drop unguarded fast-path

#### task-graph

- swap nonexistent storage.search for query in clearOlderThan
- clean up listeners on reader.cancel() in createStreamFromTaskEvents
- stamp saturating depth on over-cap bridge + dedupe warn per parent
- cap bridgeSubGraphTaskEvents depth to prevent event amplification
- bubble subgraph events from iterator/map/reduce loops (#599)

#### cache

- exclude live runIds from janitor sweep to prevent in-flight cache-row deletion

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

### Performance

#### task-graph

- stream distinct runIds via queryPage in clearOlderThan

## 0.3.21

### Bug Fixes

#### task-graph

- emit task_progress from per-task progress subscription

## 0.3.20

### Features

#### task-graph

- bubble subgraph events for While and Fallback (data) groups
- emit and bubble per-task task_progress events
- bubble subgraph events from streaming groups too
- bubble subgraph task events up to the parent graph
- emit graph-level task_complete event per finished task

### Bug Fixes

#### task-graph

- only emit task_progress while a task is actively running
- tear down subgraph event bridges in finally
- harden task_complete emit against throwing listeners

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

### Bug Fixes

- eslint fixes

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Bug Fixes

#### task-graph,storage

- cache restart-resume + SharedInMemory sync barrier (#552)

### Documentation

#### task-graph

- fix TaskOutputTabularRepository README examples for new constructor signature

## 0.3.13

### Refactors

- optimize task output repository implementations
- update task graph wrapper registration and fix circular issues
- streamline TaskOutputTabularRepository and enhance task graph wrappers
- unify task output storage implementation
- update cache keying for private slots to use taskId

## 0.3.12

### Chores

- comment review pass across packages and providers

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

### Bug Fixes

#### task-graph

- cacheable deprecation gate keys by class name when type unset; add verbose env override

### Refactors

- remove pre-v1 backward-compat code paths (#523)

## 0.3.1

## 0.3.0

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

#### task-graph

- policy-driven cache layer with durable execution

### Refactors

#### task-graph

- remove entitlements from Task serialization

### Documentation

#### task-graph

- document cache layer, runId, and durable execution

### Chores

- format

## [Unreleased]

### Added

- `CachePolicy` discriminated union (`deterministic` / `private` / `none`) declared via static `Task.cachePolicy` or instance `getCachePolicy(inputs)` override for input-dependent policies.
- `Task.version` static + `getCacheVersion()` for explicit cache invalidation. Bumping the version invalidates cached outputs.
- `CacheRegistry` service registered under `CACHE_REGISTRY` token with two optional slots (`deterministic`, `private`). Missing slot = no-op caching.
- `RunPrivateCacheRepo` namespacing wrapper keyed by `runId`. `TaskGraphRunner` builds this automatically when `runId` is supplied in run config.
- `CacheJanitor.sweepStaleRunPrivate(olderThanMs)` for app-scheduled cleanup of crashed-run cache rows.
- New abstract methods on `TaskOutputRepository`: `isDurable()`, `deleteByTaskTypePrefix()`, `clearOlderThanWithTaskTypePrefix()`, `sizeByTaskTypePrefix()`. `TaskOutputTabularRepository` provides default implementations via row iteration.

### Changed

- `TaskRunner` resolves the per-task cache via `CACHE_REGISTRY` in the `ServiceRegistry` and routes by `getCachePolicy(inputs)`. Legacy `config.outputCache: TaskOutputRepository` still works as a back-compat shim mapped to the `deterministic` slot.
- `TaskGraphRunner` threads `runId` through `IExecuteContext`. Throws `TaskConfigurationError` if a graph contains a `private`-policy task but no `runId` is provided. Awaits `clearRun()` on successful completion; failed/aborted runs leave entries for restart or TTL sweep.
- Cache key now includes the task's `cacheVersion` via a reserved `__cv` sentinel injected into normalized inputs. Tasks may not declare an input port named `__cv` (rejected at construction).
- `AiImageOutputTask` now routes to `private` when no `seed` is supplied (was: uncached) and `deterministic` when seeded.
- Telemetry span attribute renamed from `workglow.task.cacheable` (boolean) to `workglow.task.cache_policy` (string) and is now set after policy resolution, so input-dependent policies report the correct value.

### Deprecated

- `static cacheable: boolean` on Task subclasses. Use `static cachePolicy: CachePolicy = { kind: "none" | "deterministic" | "private" }` instead. The boolean shim emits a one-shot warning per task type and will be removed in a future release.
- `ITaskStaticProperties.cacheable` interface field marked `@deprecated`. The interface now declares the optional `cachePolicy` field as the canonical replacement.

### Migration

- Replace `static cacheable = false` with `static cachePolicy: CachePolicy = { kind: "none" }`.
- Replace any `outputCache: someRepo` run-config use with registering a `CacheRegistry` instance in `ServiceRegistry`:
  ```ts
  services.registerInstance(CACHE_REGISTRY, new DefaultCacheRegistry({ deterministic: repo }));
  ```
- Provide a `runId` in `IRunConfig` when running graphs with `private`-policy tasks (caller-supplied; typically a UUID matching a DB row).

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### ai

- update image input handling across vision tasks

#### job-queue

- enhance error handling with machine-readable codes

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

## 0.2.35

### Features

#### ai,task-graph

- thread runConfig through CreateWorkflow and AI wrappers (#490)

### Bug Fixes

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Chores

- release 30 packages
- release 30 packages
- fixup some wrong links after rename

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

## 0.2.34

## 0.2.33

### Chores

- fixup some wrong links after rename

## 0.2.32

### Features

- introduce IEntitlementProfile with signal-source port and conformance suite (#469)

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

### Chores

- fix merge issues after rebase and do a format
- format

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Refactors

#### tests

- move Dataflow and transform tests

## 0.2.29

## 0.2.28

### Refactors

- update libs imports for queue/limiter symbols moved to @workglow/job-queue

## 0.2.27

### Features

#### storage

- enhance queryIndex functionality and add tests

## 0.2.26

## 0.2.25

### Features

#### task-graph

- TaskRunner.run() throws on concurrent re-entry
- TaskGraphRunner.runGraph auto-creates ResourceScope when none passed
- TaskRunner.run auto-creates ResourceScope when none passed

### Bug Fixes

#### task-graph

- address Copilot PR review on ResourceScope auto-ownership
- await handleError in runGraph epilogue
- runtime guard for unset RunScheduler in StreamPump
- RunContext disposes parentSignal listener on terminal handlers

### Refactors

#### task-graph

- extract StreamProcessor from TaskRunner
- extract CacheCoordinator from TaskRunner
- dedupe schema resolution into private resolveSchemas()
- migrate per-run state from facade fields to TaskRunContext
- add TaskRunContext value object for per-run state
- pattern-parity follow-ups from refactor-taskgraph-runner
- per-run streaming unsub + real spec #7/#8 coverage
- apply PR #448 review feedback
- extract DSL state machine to WorkflowBuilder
- extract loop-builder mode into LoopBuilderContext
- extract event subscription lifecycle to WorkflowEventBridge
- extract cache wiring to WorkflowCacheAdapter
- extract private WorkflowTask class to its own file
- extract Create*Workflow factories to WorkflowFactories.ts
- extract pipe/parallel/getLastTask/connect to WorkflowPipe.ts
- move schema helpers from Workflow.ts to GraphSchemaUtils.ts
- re-tighten widened facade members to protected
- extract RunScheduler from TaskGraphRunner
- privatize StreamPump.pushStreamToEdges
- extract StreamPump from TaskGraphRunner
- extract EdgeMaterializer from TaskGraphRunner
- migrate per-run state from facade fields to RunContext
- add RunContext value object for per-run state

### Style

#### task-graph

- prettier collapse on StreamPump import block

### Tests

#### task-graph

- add unit tests for Workflow internal seams

### Documentation

#### task-graph

- mark Workflow internal collaborators as @internal
- document ResourceScope auto-ownership on public surface
- correct CacheCoordinator.buildKey JSDoc
- clean up Task 2 JSDoc nits
- enhance documentation for RunScheduler and TaskGraphRunner
- document Runner facade + collaborators + RunContext
- clean up Task 5 doc-hygiene leftovers
- mark widened EdgeMaterializer back-ref members @internal

### Chores

- format

## 0.2.24

### Refactors

#### job-queue

- same-process hot-path optimization + correctness fixes (#426)

## 0.2.23

### Bug Fixes

#### test

- enhance preview output handling in TaskRunner

## 0.2.22

## 0.2.21

### Features

#### task-graph

- indeterminate progress and StreamPhase events

#### ai

- image generation pipeline with ImageValue boundary

## 0.2.20

## 0.2.19

### Features

#### task-graph

- introduce runWithPreviews flag for subgraph execution

## 0.2.18

### Features

#### task-graph

- refcountable predicate registry; runner retains for fanout safety

#### util/media, tasks/image, ai, task-graph

- GpuImage pipeline (Phases 1-8)

### Bug Fixes

- test

### Refactors

#### task-graph, util/media

- unify refcountable predicate registration and enhance image handling

## 0.2.17

### Features

#### task-graph,tasks

- split run() from runPreview() and add execute() to concrete tasks

### Bug Fixes

- address code-reviewer feedback

### Refactors

#### libs

- rename executeReactive -> executePreview

### Documentation

- rewrite execution-model documentation for run/runPreview contract

## 0.2.16

### Features

#### task-graph

- instrument runReactive with gated telemetry
- dataflow transforms engine with autoConnect refactor

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

### Chores

- release 12 packages

## 0.2.15

### Features

#### task-graph

- instrument runReactive with gated telemetry
- dataflow transforms engine with autoConnect refactor

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

## 0.2.14

### Features

#### task-graph

- require explicit iteration bounds, document cycle guarantees, add forEach/if combinators (#424)

#### entitlements

- return structured denials with reason + add can() (#422)

### Bug Fixes

#### cli

- improve terminal theme detection and stdin handling

## 0.2.13

### Refactors

#### task-graph

- simplify input handling for root tasks

## 0.2.12

### Refactors

#### task-graph

- introduce isPassthrough flag for task types

## 0.2.11

### Refactors

#### task-graph

- enhance progress reporting in FallbackTaskRunner, IteratorTaskRunner, and WhileTask

## 0.2.10

## 0.2.9

### Features

#### ai

- AiChatTask, canonical ChatMessage, and worker streaming

### Refactors

#### task-graph

- clean up imports and improve formatting

## 0.2.8

## 0.2.7

### Features

#### browser-control

- add browser automation framework with multiple backends

#### util

- add ResourceScope for heavyweight resource lifecycle management

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

### Bug Fixes

#### task-graph

- prevent infinite recursion in subGraph entitlement subscription (#408)

## 0.2.4

### Features

#### task-graph

- add subGraph entitlement subscription handling
- support multiple wildcards in entitlement resource patterns (#406)

## 0.2.3

### Features

- add SSRF protection to FetchUrlTask with dynamic entitlements (#405)

#### tasks

- add DocumentUpsertTask for document persistence

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- auto-connect passthrough tasks (e.g. DebugLogTask) to downstream… (#373)

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### schema

- add allOf support to schema helpers and cycle detection … (#388)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)
- use listen-first-then-check pattern for abort signal… (#391)
- resolve race condition in GraphAsTask.executeStream() (#378)

#### tests

- update ScopedStorage tests for type safety

### Chores

- release 12 packages
- format changes

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- auto-connect passthrough tasks (e.g. DebugLogTask) to downstream… (#373)

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### schema

- add allOf support to schema helpers and cycle detection … (#388)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)
- use listen-first-then-check pattern for abort signal… (#391)
- resolve race condition in GraphAsTask.executeStream() (#378)

#### tests

- update ScopedStorage tests for type safety

### Chores

- format changes

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Features

#### queue-status

- remove JobQueueTask from the task class heirarchy

#### task-graph

- add graph-level timeout, task allowlist, and resource cleanup features (#339)

#### storage

- update McpServerRecordSchema to include auth_type and refactor createMcpStorage function

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

### Refactors

#### tasks

- consolidate MCP client utilities and add registry resolution for them to configs

### Chores

- remove unnecessary comments that restate code or reference commits

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### example-web

- refactor storage implementation and update model imports

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

### Features

#### task-graph

- integrate Chrome DevTools formatters and update imports into task-graph, which is what it is used for. done moving this around now.

### Documentation

- Storage examples: **`await Sqlite.init()`** before `SqliteTabularStorage` with a path (see `src/storage/README.md` and package README).

## 0.0.124

### Refactors

#### task

- enhance input handling with Partial types
- clean up input handling and improve parameter naming

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

#### schema

- remove @workglow/schema package move to back to util

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

#### cli

- implement CLI task UI components and subscription handling

#### task

- optimize JSON serialization in Task class

### Bug Fixes

#### task-graph

- improve output handling in TaskGraphRunner
- add registry parameter to task runners

### Refactors

- update package exports to use source files instead of dist

#### task

- improve JSON serialization logic in Task class

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

### Bug Fixes

#### task-graph

- filter toJSON config through configSchema to prevent node property issues (#322)

## 0.0.119

### Features

- enhance Workflow input handling for manual schemas
- add chrome web browser provider (#303)

#### task

- optimize JSON serialization in Task class

#### task-graph

- make context.own() propagate registry and abort signal to owned tasks (#296)

### Bug Fixes

#### task-graph

- improve task abortion handling in TaskGraphRunner
- improve output handling in TaskGraphRunner
- add registry parameter to task runners

### Refactors

- move prototype assignments to Workflow.ts to resolve circular dependency issues
- unify tool call handling across providers

### Chores

- release 14 packages
- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.118

### Features

- add chrome web browser provider (#303)

#### task-graph

- make context.own() propagate registry and abort signal to owned tasks (#296)

### Refactors

- move prototype assignments to Workflow.ts to resolve circular dependency issues
- unify tool call handling across providers

### Chores

- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.117

### Features

#### task-graph

- make context.own() propagate registry and abort signal to owned tasks (#296)

### Refactors

- unify tool call handling across providers

### Chores

- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.116

### Features

- add opentelemetry tracing (#292)
- add group and endGroup methods to Workflow for GraphAsTask support
- add graphToWorkflowCode utility for converting TaskGraph to Workflow code

### Bug Fixes

- pass DI registry explicitly in tests, add registry support to Workflow.run() (#287)
- update ONNX model ID and dtype across multiple files

### Refactors

- resolve circular dependency
- clean up code formatting and imports across multiple files
- streamline task configuration and code generation in GraphToWorkflowCode

### Style

- fix prettier formatting in GraphToWorkflowCode files

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.111

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

### Bug Fixes

- ensure type safety for input and output schemas across AI tasks

## 0.0.109

## 0.0.108

## 0.0.107

## 0.0.106

### Features

- add tool-calling command to CLI for sending prompts with tool definitionsl; improved toolcall

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/job-queue@0.0.105
  - @workglow/storage@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/job-queue@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/job-queue@0.0.103
  - @workglow/storage@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/job-queue@0.0.102
  - @workglow/storage@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/job-queue@0.0.101
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/job-queue@0.0.100
  - @workglow/storage@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/job-queue@0.0.99
  - @workglow/storage@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/job-queue@0.0.98
  - @workglow/storage@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/job-queue@0.0.97
  - @workglow/storage@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/job-queue@0.0.96
  - @workglow/storage@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/job-queue@0.0.95
  - @workglow/storage@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/job-queue@0.0.94
  - @workglow/storage@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/job-queue@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/job-queue@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/util@0.0.91
  - @workglow/job-queue@0.0.91
  - @workglow/storage@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/util@0.0.90
  - @workglow/job-queue@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/job-queue@0.0.89
  - @workglow/storage@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/job-queue@0.0.88
  - @workglow/storage@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/job-queue@0.0.87
  - @workglow/storage@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/job-queue@0.0.86
  - @workglow/storage@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/job-queue@0.0.85
  - @workglow/storage@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/job-queue@0.0.84
  - @workglow/storage@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/job-queue@0.0.83
  - @workglow/storage@0.0.83
  - @workglow/util@0.0.83

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo
- Updated dependencies
  - @workglow/job-queue@0.0.82
  - @workglow/storage@0.0.82
  - @workglow/util@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/job-queue@0.0.81
  - @workglow/storage@0.0.81
  - @workglow/util@0.0.81

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes
- Updated dependencies
  - @workglow/job-queue@0.0.80
  - @workglow/storage@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/job-queue@0.0.79
  - @workglow/storage@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/job-queue@0.0.78
  - @workglow/storage@0.0.78
  - @workglow/util@0.0.78

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes
- Updated dependencies
  - @workglow/job-queue@0.0.77
  - @workglow/storage@0.0.77
  - @workglow/util@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/job-queue@0.0.76
  - @workglow/storage@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/job-queue@0.0.75
  - @workglow/storage@0.0.75
  - @workglow/util@0.0.75

## 0.0.74

### Patch Changes

- Another attempt at transferables
- Updated dependencies
  - @workglow/job-queue@0.0.74
  - @workglow/storage@0.0.74
  - @workglow/util@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/job-queue@0.0.73
  - @workglow/storage@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/job-queue@0.0.72
  - @workglow/storage@0.0.72
  - @workglow/util@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/job-queue@0.0.71
  - @workglow/storage@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/job-queue@0.0.70
  - @workglow/storage@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/job-queue@0.0.69
  - @workglow/storage@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/job-queue@0.0.68
  - @workglow/storage@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/job-queue@0.0.67
  - @workglow/storage@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/job-queue@0.0.66
  - @workglow/storage@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/job-queue@0.0.65
  - @workglow/storage@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/job-queue@0.0.64
  - @workglow/storage@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/job-queue@0.0.63
  - @workglow/storage@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/job-queue@0.0.62
  - @workglow/storage@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/job-queue@0.0.61
  - @workglow/storage@0.0.61
  - @workglow/util@0.0.61

## 0.0.60

### Patch Changes

- Rework and simplify the model repo
- Updated dependencies
  - @workglow/job-queue@0.0.60
  - @workglow/storage@0.0.60
  - @workglow/util@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/storage@0.0.59
  - @workglow/util@0.0.59
  - @workglow/job-queue@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/job-queue@0.0.58
  - @workglow/storage@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/job-queue@0.0.57
  - @workglow/storage@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/util@0.0.56
  - @workglow/job-queue@0.0.56
  - @workglow/storage@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/job-queue@0.0.55
  - @workglow/storage@0.0.55
  - @workglow/util@0.0.55

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask
- Updated dependencies
  - @workglow/job-queue@0.0.54
  - @workglow/storage@0.0.54
  - @workglow/util@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/job-queue@0.0.53
  - @workglow/storage@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/job-queue@0.0.52
  - @workglow/storage@0.0.52
  - @workglow/util@0.0.52
