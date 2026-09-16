# @workglow/job-queue

## 0.6.3

_No changes in this package._

## 0.6.2

_No changes in this package._

## 0.6.1

### Features

#### job-queue,util,ai

- carry a failure's retryability across the worker boundary

### Bug Fixes

#### util

- move humanPromptModel where a browser can reach it

### Tests

#### test-contract

- close four gaps a review found in the new suites

## 0.6.0

_No changes in this package._

## 0.5.1

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

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

### Build

- types

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

## 0.3.46

### Bug Fixes

#### tasks

- fail a queued "stream" fetch whose deltas never arrived

## 0.3.45

### Breaking Changes

- **features(job-queue)**: pace a producing job by its stream consumers
- **features(job-queue)**: emitStreamEvent returns a delivery promise

### Features

#### job-queue

- pace a producing job by its stream consumers
- emitStreamEvent returns a delivery promise

### Bug Fixes

#### job-queue

- hold a job's claim while a stream event is parked
- advertise onStream only where an event can be delivered

### Refactors

#### tasks

- pin response_type at every call site

### Tests

#### job-queue

- fix pacing test setup and cover the half-channel gate

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

## 0.3.39

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

#### job-queue

- retry promptly when an idle peek finds a ready job

### Refactors

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Tests

- run tests through Turbo and per-package vitest projects
- move 174 more unit tests into their owning packages

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

### Features

#### job-queue

- storage-only client reassembles the stream channel into onStream
- worker publishes stream chunks to the queue channel
- forward stream-channel capability through WrappedMessageQueue
- InMemory stream-channel reference carrier
- stream-channel contract + StreamReassembler
- capability-gated JobHandle.outputStream for cached binary results
- in-process stream observability via JobHandle.onStream

### Bug Fixes

- restore branch-final content drifted during the rebase onto main

#### job-queue

- close stream-channel review findings
- harden the cross-process stream channel
- stream-channel code-review fixes
- drop stale classToStorage import in JobQueueWorker

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

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

## 0.3.23

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

## 0.3.22

### Bug Fixes

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

## 0.3.21

## 0.3.20

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

## 0.3.4

## 0.3.3

## 0.3.2

### Bug Fixes

#### review

- align findActiveByFingerprint fallback comment with actual cap

#### job-queue,aws,cloudflare

- batch markEnqueueDeferred to avoid serial DB hits on batch failure

#### job-queue

- findActiveByFingerprint scans past first 100 rows with bounded cap
- WrappedClaim.ack/fail no longer inherits prior-attempt output on reclaimed lease
- WrappedClaim.ack/fail no longer inherits prior-attempt output on reclaimed lease

### Refactors

- remove pre-v1 backward-compat code paths (#523)

## 0.3.1

## 0.3.0

### Features

#### job-queue

- IJobStore decomposition + processClaims for cloud transports

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### job-queue

- enhance error handling with machine-readable codes

### Bug Fixes

- FetchUrl permanent codes + SQLite v4 + error-code registry (#518)

#### job-queue

- follow-up correctness fixes to PR #511 (#513)

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

## 0.2.35

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

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

#### storage

- real migrations + shared SQL builder + vector index tuning

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

## 0.2.30

### Chores

- update docs to reflect current code

## 0.2.29

## 0.2.28

### Refactors

- update libs imports for queue/limiter symbols moved to @workglow/job-queue

#### util

- consolidate traced helper into @workglow/util/telemetry

#### job-queue

- move IRateLimiterStorage + InMemory from @workglow/storage
- move IQueueStorage + InMemory + Telemetry from @workglow/storage

### Chores

- format

## 0.2.27

### Bug Fixes

#### job-queue

- release by token to fix wrong-row deletion under contention

### Refactors

#### job-queue

- atomic claim+limit, LISTEN/NOTIFY, and same-process hot-path

## 0.2.26

## 0.2.25

## 0.2.24

### Refactors

#### job-queue

- same-process hot-path optimization + correctness fixes (#426)

## 0.2.23

## 0.2.22

## 0.2.21

## 0.2.20

## 0.2.19

## 0.2.18

## 0.2.17

## 0.2.16

### Chores

- release 12 packages

## 0.2.15

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

## 0.2.6

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- await async operations in CompositeLimiter methods (#376)

### Chores

- release 12 packages

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- await async operations in CompositeLimiter methods (#376)

## 0.1.2

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Chores

- remove unnecessary comments that restate code or reference commits

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

### Documentation

- README: `SqliteQueueStorage` takes an opened **`Sqlite.Database`**; call **`await Sqlite.init()`** first (see `@workglow/sqlite/storage`).

## 0.0.124

## 0.0.123

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

### Refactors

- update package exports to use source files instead of dist

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)

### Bug Fixes

#### job-queue

- improve error handling during job deletion in JobQueueServer

### Chores

- release 14 packages
- update tsconfig to avoid node_modules

## 0.0.118

### Features

- add chrome web browser provider (#303)

### Chores

- update tsconfig to avoid node_modules

## 0.0.117

### Chores

- update tsconfig to avoid node_modules

## 0.0.116

### Features

- add opentelemetry tracing (#292)

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.110

### Features

- add build-js and watch-js scripts across packages
- enhance job processing and worker notification in JobQueueServer and JobQueueWorker
- replace worker polling with event-driven wake/sleep mechanism

### Bug Fixes

- ensure type safety for input and output schemas across AI tasks

## 0.0.109

## 0.0.108

## 0.0.107

## 0.0.106

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/storage@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/storage@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/storage@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/storage@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/storage@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/storage@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/storage@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/storage@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/storage@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/storage@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/storage@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/storage@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/util@0.0.91
  - @workglow/storage@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/util@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/storage@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/storage@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/storage@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/storage@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/storage@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/storage@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/storage@0.0.83
  - @workglow/util@0.0.83

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo
- Updated dependencies
  - @workglow/storage@0.0.82
  - @workglow/util@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/storage@0.0.81
  - @workglow/util@0.0.81

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes
- Updated dependencies
  - @workglow/storage@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/storage@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/storage@0.0.78
  - @workglow/util@0.0.78

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes
- Updated dependencies
  - @workglow/storage@0.0.77
  - @workglow/util@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/storage@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/storage@0.0.75
  - @workglow/util@0.0.75

## 0.0.74

### Patch Changes

- Another attempt at transferables
- Updated dependencies
  - @workglow/storage@0.0.74
  - @workglow/util@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/storage@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/storage@0.0.72
  - @workglow/util@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/storage@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/storage@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/storage@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/storage@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/storage@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/storage@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/storage@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/storage@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/storage@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/storage@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/storage@0.0.61
  - @workglow/util@0.0.61

## 0.0.60

### Patch Changes

- Rework and simplify the model repo
- Updated dependencies
  - @workglow/storage@0.0.60
  - @workglow/util@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/storage@0.0.59
  - @workglow/util@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/storage@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/sqlite@0.0.57
  - @workglow/storage@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/util@0.0.56
  - @workglow/sqlite@0.0.56
  - @workglow/storage@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/sqlite@0.0.55
  - @workglow/storage@0.0.55
  - @workglow/util@0.0.55

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask
- Updated dependencies
  - @workglow/storage@0.0.54
  - @workglow/sqlite@0.0.54
  - @workglow/util@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/sqlite@0.0.53
  - @workglow/storage@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/storage@0.0.52
  - @workglow/sqlite@0.0.52
  - @workglow/util@0.0.52
