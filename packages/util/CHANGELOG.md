# @workglow/util

## 0.6.3

_No changes in this package._

## 0.6.2

### Features

#### cli,util

- let a person refuse a form, not only submit or abandon it

### Performance

#### test

- decrypt test credentials once per run, not once per test file

## 0.6.1

### Features

#### job-queue,util,ai

- carry a failure's retryability across the worker boundary

### Bug Fixes

#### util

- move humanPromptModel where a browser can reach it

### Refactors

- share the HTTP server guards out of the MCP server

#### util,mcp

- share the JSON-RPC HTTP scaffolding, not just its predicates

## 0.6.0

_No changes in this package._

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

### Bug Fixes

#### util

- repair the Node worker path and drop the Bun worker fork

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

### Bug Fixes

#### tasks

- apply default output caps and report match/truncated honestly
- cap FileGrepTask line length instead of accumulating unterminated lines
- bound FileGrepTask regex matching with an interruptible time budget

## 0.3.46

### Bug Fixes

#### worker

- resolve type mismatch in message event data handling

## 0.3.45

## 0.3.44

### Features

#### util

- declare x-ui-placeholder and x-ui-disabled

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

## 0.3.39

### Features

#### util

- add a ./test entry and drop _testOnly from the public API

### Bug Fixes

- reunite the graph test helper with its dependents
- make the ./test entries survive a real build

#### util

- last complete object wins when skipping JSON preamble (#718)
- resolve repo-root script imports independently of the vitest root
- stop TestingLogger inlining a second ConsoleLogger

#### test

- close the gaps the Turbo/projects wiring opened

### Performance

#### util

- add an incremental partial-JSON stream parser (#681)

### Tests

- run tests through Turbo and per-package vitest projects
- move 174 more unit tests into their owning packages
- settle the Bun policy, close a CI gap, and pilot the __tests__ move
- discover test files instead of enumerating sections

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## Unreleased

### Bug Fixes

#### util

- `createPartialJsonStream({ skipPreamble: true })`: **last complete object wins**.
  A closed root is now provisional — it is retained and scanning resumes, so a
  later `{` starts a fresh candidate that supersedes it. Previously the parser
  latched onto the FIRST syntactically valid object in the preamble and ignored
  the real payload, while still reporting `complete: true`. A thinking model that
  restates the schema (`{"type":"object"}`) or shows a few-shot example
  (`{"name":"Alice"}`) before answering therefore returned the wrong document —
  and a schema-shaped one passes re-validation, so it was persisted silently.
  Nothing is re-scanned, so the parser stays O(total input); the accepted
  trade-off is that trailing prose containing a complete object now supersedes
  the payload. `Mode.Done` is no longer reachable in this mode, so the parser
  keeps scanning trailing text for the life of the stream (bounded, no buffering).
- `PartialJsonStream.complete` no longer reports `true` for a root that only
  closed because `finish()` repaired a truncated token (`push('"abc')`).

### BREAKING

#### util

- `PartialJsonStream.finish()` is now declared as `JsonValue` (a new exported
  type) instead of `Record<string, unknown>`. The runtime behavior is unchanged
  — an array- or scalar-rooted document was always returned as such — but the
  declared type was a lie, so `Object.keys(stream.finish())` on an array root
  type-checked and silently produced `["0","1","2"]`. Callers feeding a consumer
  that requires an object should switch to the new
  `PartialJsonStream.finishObject()`, which yields `{}` for an array or scalar
  root; all in-repo provider run-fns have been migrated. Third-party run-fns
  calling `finish()` will see a compile break — intentionally.

## 0.3.38

### Features

#### util

- transfer binary stream chunks across the worker boundary

#### task-graph

- binary-streaming framework + result-as-reference

### Bug Fixes

#### task-graph,util

- close storage and worker review findings

#### util

- transfer only fully-owned buffers for worker stream chunks

## 0.3.37

### Features

#### dataUri

- implement dataUriToBlob function for decoding data URIs to Blobs

### Bug Fixes

- data-URI decode order, own() tracking for functions, UI wiring
- bound CLI listener retention, reject double-own, decode binary data URIs

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

### Bug Fixes

#### util,llamacpp

- tenant-scope id and per-session mutex prep

## 0.3.28

## 0.3.27

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Bug Fixes

#### util

- make objectOfArraysAsArrayOfObjects work with native array methods

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

## 0.3.23

### Bug Fixes

#### util

- make objectOfArraysAsArrayOfObjects work with native array methods

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Chores

- format / lint

## 0.3.22

### Bug Fixes

#### review

- resolve xhigh code-review findings on cherry-picked 601+604

#### util/di

- drain eviction disposals and clear stale factories on registerInstance
- dispose previously cached singleton on register replacement

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

### Chores

- update deps

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

### Features

#### util

- add Hmac utility

## 0.3.16

### Chores

- update deps

## 0.3.15

### Bug Fixes

- eslint fixes

#### mcp,supabase

- credential-leak fail-closed + vector dim validation (2 HIGH from code review) (#579)

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

## 0.3.13

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

### Features

#### cactus

- enhance Cactus_ModelInfo to report cache status and file sizes

## 0.3.4

## 0.3.3

## 0.3.2

### Bug Fixes

#### util

- scrub absolute paths from worker error stacks; omit in production unless WORKGLOW_INCLUDE_STACKS=1

### Refactors

- remove pre-v1 backward-compat code paths (#523)

## 0.3.1

### Bug Fixes

#### util

- preserve worker error stack across postMessage

## 0.3.0

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### ai

- update image input handling across vision tasks

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

### Bug Fixes

#### util/worker, ai/task

- TTL-based pendingAborts eviction; clarify runWithIterable bond (#500)

#### util

- snapshot-then-delete eviction in WorkerServerBase Set caps

## 0.2.35

### Features

#### ai,util/worker

- Promise+emit run-fn shape foundation

### Bug Fixes

#### util/worker

- apply aborts that arrive before the call starts

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

### Refactors

#### ai

- finalize Promise+emit migration and cleanup

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

#### storage

- mutex-serialize SQLite + Postgres tabular ops to close withTransaction concurrency hole

### Bug Fixes

#### storage

- inline mutex into SQLite + Postgres storages instead of exporting from util

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers

### Chores

- format

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

## 0.2.29

## 0.2.28

### Refactors

#### util

- consolidate traced helper into @workglow/util/telemetry

## 0.2.27

## 0.2.26

## 0.2.25

## 0.2.24

### Refactors

#### job-queue

- same-process hot-path optimization + correctness fixes (#426)

## 0.2.23

## 0.2.22

## 0.2.21

### Features

#### ai

- introduce TypeLandmark schema and update related tasks
- image generation pipeline with ImageValue boundary

## 0.2.20

### Chores

#### util,storage

- introduce fast deepEqual; replace JSON.stringify equality

## 0.2.19

## 0.2.18

### Features

#### util/media

- previewSource composes scale via _setPreviewScale
- GpuImage carries previewScale; backends implement; apply() propagates

#### tasks/image

- add CSS rgb/rgba color schema and validation

#### util/media, tasks/image

- real WGSL shaders for 16 image filters
- refcount-based GpuImage lifecycle; eliminate releaseSource

#### util/media, tasks

- previewSource downscales WebGPU images at the chain head

#### util/media, tasks/image, ai, task-graph

- GpuImage pipeline (Phases 1-8)

### Bug Fixes

#### tasks/image

- hydrateInput handles ImageBinary, Blob, ImageBitmap, and data: URIs

### Refactors

#### tasks/image

- consolidate image filter operations and update imports

#### util/media, tasks/image

- colocate WGSL per filter; apply.shader is raw string

#### task-graph, util/media

- unify refcountable predicate registration and enhance image handling

## 0.2.17

### Bug Fixes

- address code-reviewer feedback

### Refactors

#### util,ai

- rename worker reactive APIs to preview for consistency

### Chores

- format changes

## 0.2.16

### Features

#### util/media

- introduce Image class and consolidate image handling
- add color type system

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

### Refactors

#### ai

- simplify and consolidate RAG tasks (#427)

### Chores

- release 12 packages
- update deps

### Updated Dependencies

- `@sroussey/json-schema-library`: ^11.4.0

## 0.2.15

### Features

#### util/media

- introduce Image class and consolidate image handling
- add color type system

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

### Chores

- update deps

### Updated Dependencies

- `@sroussey/json-schema-library`: ^11.4.0

## 0.2.14

## 0.2.13

## 0.2.12

## 0.2.11

## 0.2.10

## 0.2.9

### Features

#### ai

- AiChatTask, canonical ChatMessage, and worker streaming

## 0.2.8

## 0.2.7

### Features

#### util

- add ResourceScope for heavyweight resource lifecycle management

#### storage

- enhance KvViaTabularStorage with JSON serialization handling

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

### Tests

#### graph

- add NodeDoesntExistError handling in DirectedAcyclicGraph and enhance DirectedGraph tests

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add lifecycle management across core infrastructure (#384)
- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)

#### util

- target specific node pair in removeEdge instead of scannin… (#374)
- fold readyWorkers await into single-flight guard in Worker… (#382)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### graph

- count actual edges in indegreeOfNode instead of slot pres… (#375)

### Chores

- release 12 packages
- format changes

## 0.1.3

### Features

- add lifecycle management across core infrastructure (#384)
- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)

#### util

- target specific node pair in removeEdge instead of scannin… (#374)
- fold readyWorkers await into single-flight guard in Worker… (#382)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### graph

- count actual edges in indegreeOfNode instead of slot pres… (#375)

### Chores

- format changes

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Bug Fixes

#### util

- critical bug fixes and robustness improvements (#336)

### Chores

- remove unnecessary comments that restate code or reference commits

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

## 0.0.125

### Features

#### task-graph

- integrate Chrome DevTools formatters and update imports into task-graph, which is what it is used for. done moving this around now.

### Refactors

#### debug

- remove @workglow/debug package and integrate debug utilities into @workglow/util

## 0.0.124

### Refactors

#### task

- clean up input handling and improve parameter naming

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

#### schema

- remove @workglow/schema package move to back to util

## 0.0.122

### Features

- enhance CLI with MCP support and input handling

#### schema

- introduce @workglow/schema package for schema validation utilities

### Refactors

- update package exports to use source files instead of dist
- more moving around to make workers smaller (95% smaller now)
- ai provider

#### util

- reorganize MCP-related and toolcalling related code
- fixed WorkerServer based on each platform

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- enhance Workflow input handling for manual schemas
- add chrome web browser provider (#303)

### Refactors

- update MCP task schemas to use properties and allOf from mcpServerConfigSchema
- move prototype assignments to Workflow.ts to resolve circular dependency issues

### Chores

- release 14 packages
- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

## 0.0.118

### Features

- add chrome web browser provider (#303)

### Refactors

- update MCP task schemas to use properties and allOf from mcpServerConfigSchema
- move prototype assignments to Workflow.ts to resolve circular dependency issues

### Chores

- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

## 0.0.117

### Chores

- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

## 0.0.116

### Features

- add opentelemetry tracing (#292)

### Refactors

- clean up code formatting and imports across multiple files

## 0.0.115

## 0.0.114

### Updated Dependencies

- `@sroussey/json-schema-library`: ^11.0.0

## 0.0.113

## 0.0.111

### Features

- implement MCP OAuth provider and authentication types (#266)

## 0.0.110

### Features

- add build-js and watch-js scripts across packages
- add detail property to ModelInfoTask and enhance HFT_ModelInfo processing
- enhance job processing and worker notification in JobQueueServer and JobQueueWorker

## 0.0.109

## 0.0.108

### Features

- add "x-ui-manual" property to JsonSchemaCustomProps for user-defined properties

## 0.0.107

## 0.0.106

### Features

- add tool-calling command to CLI for sending prompts with tool definitionsl; improved toolcall

## 0.0.105

### Patch Changes

- Storage rename search to query

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes

## 0.0.102

### Patch Changes

- Update types

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues

## 0.0.99

### Patch Changes

- Update deps like hf inference

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference

## 0.0.97

### Patch Changes

- client mcp support via tasks

## 0.0.96

### Patch Changes

- fix missing include dep

## 0.0.95

### Patch Changes

- fix max tokens and update cli

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks

## 0.0.93

### Patch Changes

- fix export and test

## 0.0.92

### Patch Changes

- Fix exports

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While

## 0.0.89

### Patch Changes

- Fix subgraph reactive

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes

## 0.0.79

### Patch Changes

- Merge and Split

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes

## 0.0.76

### Patch Changes

- fix array task reactive

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers

## 0.0.74

### Patch Changes

- Another attempt at transferables

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail

## 0.0.72

### Patch Changes

- Add Vision/Image tasks

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask

## 0.0.70

### Patch Changes

- Updates to download progress, etc

## 0.0.69

### Patch Changes

- Fix build

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying

## 0.0.63

### Patch Changes

- Fix more max try issues

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing

## 0.0.60

### Patch Changes

- Rework and simplify the model repo

## 0.0.59

### Patch Changes

- Rework model config

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows

## 0.0.55

### Patch Changes

- Update deps

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema

## 0.0.52

### Patch Changes

- First release under "workglow" naming
