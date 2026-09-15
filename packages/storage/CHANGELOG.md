# @workglow/storage

## 0.6.1

### Bug Fixes

#### util

- move humanPromptModel where a browser can reach it

### Tests

#### storage

- hold the two join strategies to the same answer

## 0.6.0

### Bug Fixes

#### storage

- decide the join pushdown on enlistment, not the instance flag (#934)

## 0.5.1

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

### Bug Fixes

#### postgres

- give a vector storage a real pgvector column

#### storage

- stop connection transactions hanging and leaking uncommitted rows

### Refactors

#### storage

- route the tx handle through the public methods

### Chores

- revert version change not made by bunset

## 0.4.9

### Features

#### storage

- add the not-in search operator

### Bug Fixes

#### storage

- scope connection-transaction put deferral to its own transaction
- an undefined criterion matches nothing, on every backend
- restore the deleteSearch guard on the transaction path
- align `in` with SQL on nulls, refuse a table-wide deleteSearch

### Tests

#### storage

- cover criteriaMatchNoRow directly
- pin the undefined-criterion semantics, and `!=` between two values
- move the criterion matcher tests into the tabular package

## 0.4.8

## 0.4.7

### Bug Fixes

#### storage

- keep connection-transaction put deferral off the ALS store
- queue concurrent transactions whose participants differ
- queue unrelated concurrent callers on the connection mutex

### Documentation

#### storage

- correct the re-entry precedent cited by put deferral

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Features

- add withConnectionTransaction for sibling storages on one handle. (#842)
- migrate SQLite driver from better-sqlite3 to node:sqlite (#710)

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

### Refactors

- FsFolderTabularStorage for improved file handling and error management

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

### Bug Fixes

#### tests

- remove process listeners through the EventEmitter view

## 0.3.49

## 0.3.48

## 0.3.47

### Features

#### storage

- add `withConnectionTransaction` so sibling tabular storages on one SQLite, Postgres, or DuckDB handle commit and roll back together

## 0.3.46

### Features

#### storage

- enforce numeric bounds and integer column range
- enforce varchar width and NOT NULL in InMemoryTabularStorage

### Bug Fixes

#### storage

- scope InMemory column constraints to a backend mode and document the nullable-column DDL change
- close two gaps in column-constraint derivation

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

## 0.3.39

### Features

#### storage

- enhance query operators to support null handling and inequality checks

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

### Refactors

- decompose BaseTabularStorage.ts and Task.ts along functional seams (#682)

### Tests

- run tests through Turbo and per-package vitest projects
- move 174 more unit tests into their owning packages

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

## 0.3.37

### Features

#### storage

- add an `in` set-membership operator to SearchCriteria

## 0.3.36

## 0.3.35

## 0.3.34

### Bug Fixes

- address code-review findings across the three hardening fixes

#### storage

- eliminate latent shim deadlock on same-owner tx re-entry

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

### Features

#### storage

- implement ConnectionMutex for browser and server environments

### Bug Fixes

#### storage

- browser-safe cross-instance re-entry + actionable ConnectionReentryError
- BigInt-safe primary-key fingerprint in bulk paths
- share a connection mutex across storages bound to one handle

## 0.3.28

## 0.3.27

### Bug Fixes

#### storage

- honor clientProvidedKeys 'never' in bulk putBulk; refresh docs

#### duckdb

- keep putBulk idempotent on all-primary-key tables

### Performance

#### storage

- single-statement putBulk engine + SQLite backend

### Documentation

#### storage

- document single-statement putBulk and duplicate-key semantics

## Unreleased

### Refactors

#### storage

- `BaseSqlTabularStorage` now provides a shared multi-row bulk-insert engine
  (`runBulkPut` / `buildBulkPutValues` / `BulkPutDialect`) used by the SQL
  tabular backends. `putBulk` issues one `INSERT … VALUES (…),(…),… RETURNING *`
  per chunk instead of one statement per row. Duplicate primary keys within a
  batch are deduplicated last-wins; every duplicate position returns the final
  committed row, and one `put` event fires per distinct committed row.

## 0.3.26

### Features

#### storage

- add DuckDB tabular storage backend (@workglow/duckdb) (#635)

## 0.3.25

### Bug Fixes

#### storage

- genuine CAS for updateWhere on IndexedDb + HttpTabularProxy (#628)

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

## 0.3.23

### Features

#### storage

- updateWhere on remaining backends and wrappers
- InMemory updateWhere CAS
- declare ITabularStorage.updateWhere atomic CAS

### Bug Fixes

#### storage

- updateWhere rejects patches that change a primary-key column
- FsFolder updateWhere throws unsupported instead of failing via query
- make updateWhere single-row and consistent across backends

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

## 0.3.22

### Bug Fixes

#### review

- resolve xhigh code-review findings on cherry-picked 601+604

#### storage/vector

- align in-memory + IndexedDB default scoreThreshold to 0 (match SQL backends)

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

### Refactors

#### storage

- enhance unique index handling and event emission

## 0.3.15

### Features

#### storage

- add uniqueIndexes for DB-level UNIQUE constraints + dedup overlapping regular indexes (#593)

### Bug Fixes

- eslint fixes

#### storage

- include rolled-back ids in rollback event payload (#591)

#### storage,indexeddb,postgres,sqlite

- cumulative vector-storage validation + atomicity hardening (#580/#581/#583/#584/#587) (#589)

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## Unreleased

### Bug Fixes

#### storage,indexeddb

- validate vector shape on `InMemoryVectorStorage` and `IndexedDbVectorStorage`
  `put` / `putBulk` / `similaritySearch` — closes a silent-corruption gap left
  by the original `assertVectorShape` rollout that only covered Postgres,
  SQLite, and Supabase. Lifts a `validateVectorEntities` batch helper to
  `@workglow/storage` and refactors the cloud-backed overrides to use it.

#### storage

- `InMemoryVectorStorage.putBulk` is now genuinely atomic. The inherited
  tabular `putBulk` runs writes via `Promise.all`, so a non-shape failure
  mid-batch (PK collision, listener throw, custom subclass invariant)
  could leave rows 0..N-1 committed. The vector override snapshots the
  underlying `Map` and the autoincrement counter, writes serially, and
  restores the snapshot on throw so the batch is either fully visible or
  fully absent. A `rollback` event fires on the storage emitter when the
  restore path runs, so subscribers can reconcile any per-row `put`
  events emitted before the failure.
- `InMemoryTabularStorage` now exposes `protected snapshotMutableState()`
  / `restoreMutableState()` so subclasses (vector overlays, telemetry
  wrappers) can implement atomic batch ops without reaching into private
  state.
- `TabularEventListeners` adds a `rollback` event carrying `{ op, error }`.
  Existing event subscribers are unaffected.

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Bug Fixes

#### task-graph,storage

- cache restart-resume + SharedInMemory sync barrier (#552)

## 0.3.13

### Features

- add isDurable method to in-memory storage classes

### Refactors

- optimize task output repository implementations

## 0.3.12

### Bug Fixes

#### storage

- reject puts to credential-store sentinel key

### Refactors

- rework delete events

### Chores

- comment review pass across packages and providers

## 0.3.11

### Bug Fixes

#### storage,ai

- SQL operator allow-list + baseURL validation + credential-store passphrase sentinel (#546)

## 0.3.10

### Bug Fixes

#### storage

- restore ICredentialStore contract on ServerCredentialStore (sec) (#544)
- ServerCredentialStore put-race + vault orphan on rollback failure (sec) (#540)

## 0.3.9

### Chores

- update deps

## 0.3.8

### Features

- add ServerCredentialStore for server-side credential management (#539)

## 0.3.7

### Features

#### storage

- add HttpTabularProxyStorage for remote table operations (#534)

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

### Refactors

- remove pre-v1 backward-compat code paths (#523)

## 0.3.1

## 0.3.0

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

## 0.2.36

## 0.2.35

### Features

#### knowledge-base

- hybrid search via RRF over BM25F text index (#478)

### Bug Fixes

- emit kv storage events from concrete implementations (#481)

#### knowledge-base,storage,postgres

- cross-KB getBulk leak + restore Postgres-native hybrid search (#486)

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Documentation

- add design for storage getBulk plural-get (#480)

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

### Bug Fixes

- emit kv storage events from concrete implementations (#481)

### Chores

- fixup some wrong links after rename

## 0.2.32

### Features

#### storage

- wrappers passthrough tabular migrations to inner
- tabular migrations on SharedInMemory/HF/FsFolder
- wire tabular migrations into InMemoryTabularStorage
- InMemoryTabularMigrationApplier for schemaless backends
- SqlTabularMigrationApplier base
- SQL DDL builders for tabular migrations
- tabular migration plumbing on BaseTabularStorage
- TabularMigrationOrchestrator (fast-path + sequential apply)
- runBackfill helper for tabular migrations
- re-export tabular migration types
- TabularMigrationOp + ITabularMigration + applier types
- cursor-based pagination for stable iteration under writes

#### sqlite

- tabular migration applier + constructor option

### Bug Fixes

#### tabular-migrations

- address Copilot review feedback

#### storage

- address Copilot review feedback on cursor pagination + transactions
- wrapper tx-handle forwarding + real-pool mutex bypass
- toCursorValue throws StorageValidationError, not generic Error
- address Copilot review on bigint/Date and mock parser
- NULL handling in compound keyset paths + new tests
- CI build + Copilot review feedback
- address code-review follow-ups on cursor pagination

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

#### storage

- real migrations + shared SQL builder + vector index tuning
- streamline validation and error handling for orderBy criteria
- address Copilot review on withTransaction semantics
- address review feedback on putBulk + withTransaction
- restore real putBulk + add withTransaction

### Tests

#### tabular

- per-backend contract conformance tests (Phase 9)

#### contract

- implement worker-proxy contract conformance suite (#468)

### Documentation

#### storage

- tabular migrations usage + ITabularStorage JSDoc

### Chores

#### tabular-migrations

- final formatting + scripts/test.ts wiring

#### storage

- pre-merge polish from final review (easy minors)

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Chores

- update docs to reflect current code

## 0.2.29

## 0.2.28

### Refactors

#### storage

- break temporary storage→job-queue cycle now that vendor queue impls are out

#### indexeddb

- move IndexedDB backends from @workglow/storage to @workglow/indexeddb

#### supabase

- move Supabase backends from @workglow/storage to @workglow/supabase

#### sqlite

- move SQLite backends from @workglow/storage to @workglow/sqlite

#### postgres

- move Postgres backends from @workglow/storage to @workglow/postgres

#### util

- consolidate traced helper into @workglow/util/telemetry

#### job-queue

- move IRateLimiterStorage + InMemory from @workglow/storage
- move IQueueStorage + InMemory + Telemetry from @workglow/storage

### Chores

- code-review cleanup

## 0.2.27

### Features

#### storage

- enhance queryIndex functionality and add tests

### Bug Fixes

#### job-queue

- release by token to fix wrong-row deletion under contention

#### storage

- export SharedInMemoryTabularStorage from common-server for tests

### Refactors

#### job-queue

- atomic claim+limit, LISTEN/NOTIFY, and same-process hot-path

## 0.2.26

### Features

#### storage

- Supabase + FsFolder queryIndex
- Sqlite + Postgres queryIndex with column projection
- IndexedDbTabularStorage.queryIndex via openKeyCursor
- InMemoryTabularStorage.queryIndex
- add queryIndex method to ITabularStorage interface
- pickCoveringIndex pure helper for queryIndex
- CoveringIndexMissingError for queryIndex

### Bug Fixes

#### storage

- address review on queryIndex (#453)
- CachedTabularStorage delegates queryIndex to cache

### Style

#### storage

- align CoveringIndexMissingError license header

### Chores

- format

## 0.2.25

## 0.2.24

### Features

#### storage

- implement count method across storage backends

### Refactors

#### job-queue

- same-process hot-path optimization + correctness fixes (#426)

### Chores

- format

## 0.2.23

## 0.2.22

## 0.2.21

## 0.2.20

### Chores

#### util,storage

- introduce fast deepEqual; replace JSON.stringify equality

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

### Refactors

#### kb

- update KnowledgeBase constructor to accept options object

### Chores

- refactor Supabase to be unknown so mixed minor versions are ok.

## 0.2.9

## 0.2.8

## 0.2.7

### Features

#### storage

- enhance KvViaTabularStorage with JSON serialization handling

### Refactors

#### storage

- simplify vector and tabular constructor type handling

### Chores

- format

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### storage

- queue BroadcastChannel messages during sync instead of … (#381)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### tests

- update ScopedStorage tests for type safety

### Refactors

#### storage

- streamline package.json exports for SQLite and browser

### Chores

- release 12 packages

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### cli

- keyring (#367)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### storage

- queue BroadcastChannel messages during sync instead of … (#381)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### tests

- update ScopedStorage tests for type safety

### Refactors

#### storage

- streamline package.json exports for SQLite and browser

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

#### storage,knowledge-base

- security hardening, bug fixes, and robustness improvements (#341)

### Tests

#### storage

- enhance PollingSubscriptionManager with initialization state management

### Chores

- remove unnecessary comments that restate code or reference commits

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### tests

- enhance testing framework with unit and integration test scripts separated for github actions

#### storage

- move @workglow/sqlite package into @workglow/storage/sqlite and add @workglow/storage/postgresql

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

### Features

#### sqlite

- Unified **`Sqlite.init()`** on Node (dynamic `import` of `better-sqlite3`), Bun (`bun:sqlite`), and browser (WASM). Call it once before **`new Sqlite.Database(...)`** or any storage that opens SQLite by file path.

## 0.0.124

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

#### cli

- implement nested object value manipulation functions

### Refactors

- update package exports to use source files instead of dist

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo
- rename tests to represent storage

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)

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
- add SqliteAiVectorStorage using @sqliteai/sqlite-vector extension (#291)

### Refactors

- clean up code formatting and imports across multiple files

## 0.0.115

## 0.0.114

### Updated Dependencies

- `@types/pg`: ^8.18.0

## 0.0.113

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

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
  - @workglow/sqlite@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/sqlite@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/sqlite@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/sqlite@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/sqlite@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/sqlite@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/sqlite@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/sqlite@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/sqlite@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/sqlite@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/sqlite@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/sqlite@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/sqlite@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/sqlite@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/util@0.0.91
  - @workglow/sqlite@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/util@0.0.90
  - @workglow/sqlite@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/sqlite@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/sqlite@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/sqlite@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/sqlite@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/sqlite@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/sqlite@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/sqlite@0.0.83
  - @workglow/util@0.0.83

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo
- Updated dependencies
  - @workglow/sqlite@0.0.82
  - @workglow/util@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/sqlite@0.0.81
  - @workglow/util@0.0.81

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes
- Updated dependencies
  - @workglow/sqlite@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/sqlite@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/sqlite@0.0.78
  - @workglow/util@0.0.78

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes
- Updated dependencies
  - @workglow/sqlite@0.0.77
  - @workglow/util@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/sqlite@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/sqlite@0.0.75
  - @workglow/util@0.0.75

## 0.0.74

### Patch Changes

- Another attempt at transferables
- Updated dependencies
  - @workglow/sqlite@0.0.74
  - @workglow/util@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/sqlite@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/util@0.0.72
  - @workglow/sqlite@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/sqlite@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/sqlite@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/sqlite@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/sqlite@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/sqlite@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/sqlite@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/sqlite@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/sqlite@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/sqlite@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/sqlite@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/sqlite@0.0.61
  - @workglow/util@0.0.61

## 0.0.60

### Patch Changes

- Rework and simplify the model repo
- Updated dependencies
  - @workglow/sqlite@0.0.60
  - @workglow/util@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/util@0.0.59
  - @workglow/sqlite@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/sqlite@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/sqlite@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/util@0.0.56
  - @workglow/sqlite@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/sqlite@0.0.55
  - @workglow/util@0.0.55

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask
- Updated dependencies
  - @workglow/sqlite@0.0.54
  - @workglow/util@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/sqlite@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/sqlite@0.0.52
  - @workglow/util@0.0.52
