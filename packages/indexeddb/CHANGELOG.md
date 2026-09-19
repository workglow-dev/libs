# Changelog

## 0.6.7

_No changes in this package._

## 0.6.6

_No changes in this package._

## 0.6.5

_No changes in this package._

## 0.6.4

_No changes in this package._

## 0.6.3

_No changes in this package._

## 0.6.2

_No changes in this package._

## 0.6.1

_No changes in this package._

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

### Features

#### storage

- add the not-in search operator

### Bug Fixes

#### storage

- an undefined criterion matches nothing, on every backend
- restore the deleteSearch guard on the transaction path
- align `in` with SQL on nulls, refuse a table-wide deleteSearch

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

## 0.3.46

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

#### indexeddb

- keep a null equality criterion out of IDBKeyRange

#### test

- close the gaps the Turbo/projects wiring opened

### Refactors

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Chores

- upgrade to catalog for many deps and update the deps themselves

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

### Updated Dependencies

- `fake-indexeddb`: catalog:

## 0.3.38

## 0.3.37

### Features

#### storage

- add an `in` set-membership operator to SearchCriteria

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

### Bug Fixes

#### indexeddb

- make tabular putBulk atomic via single transaction

## 0.3.26

## 0.3.25

### Bug Fixes

#### storage

- genuine CAS for updateWhere on IndexedDb + HttpTabularProxy (#628)

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

### Features

#### storage

- updateWhere on remaining backends and wrappers

### Bug Fixes

#### storage

- updateWhere rejects patches that change a primary-key column

### Chores

- format / lint

## 0.3.22

### Bug Fixes

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

- validate vector shape on `IndexedDbVectorStorage` `put` / `putBulk` /
  `similaritySearch` (paired with the matching `InMemoryVectorStorage` fix in
  `@workglow/storage`). Validation runs synchronously before any IDB
  transaction opens, so a malformed `putBulk` rejects the whole batch with no
  partial write reaching the object store.

#### indexeddb

- `IndexedDbVectorStorage.putBulk` now routes every record through a single
  `readwrite` IDB transaction instead of inheriting the
  one-transaction-per-row `Promise.all` path. A request error, transaction
  abort, or quota failure on any record aborts the whole batch — no row
  reaches the object store. **Behaviour change for subscribers**: per-row
  `put` events for a batched put now fire as a burst from `tx.oncomplete`
  rather than interleaved with each IDB request. Consumers that relied on
  the request-level ordering (none in this repo) should switch to
  `tx.oncomplete` semantics.
- `IndexedDbTabularStorage` exposes `protected putBulkInTransaction()` so
  storages that need an atomic batch can route through a single transaction;
  the base `putBulk` is unchanged to preserve existing per-row event
  semantics for non-vector callers. An `InvalidStateError` raised by an
  `onversionchange` race is absorbed with a single open-and-retry, and a
  `rollback` event fires on the storage emitter when the retry path runs.
- The per-record key-derivation logic (autoincrement, UUID,
  `clientProvidedKeys`) is now extracted into
  `protected prepareRecordForPut()` and shared by `put` /
  `putBulkInTransaction`, eliminating drift between the single- and
  batch-write paths.

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

## 0.3.13

## 0.3.12

### Refactors

- rework delete events

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

### Bug Fixes

#### job-queue

- follow-up correctness fixes to PR #511 (#513)

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

## 0.2.35

### Features

#### knowledge-base

- hybrid search via RRF over BM25F text index (#478)

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

### Chores

- fixup some wrong links after rename

## 0.2.32

### Features

#### indexeddb

- wire tabular migration applier into setupDatabase
- wire tabular migration applier into setupDatabase
- tabular migration applier
- add migration runner + per-component migrations

### Bug Fixes

#### tabular-migrations

- address Copilot review feedback

#### indexeddb

- settle probe and upgrade promises exactly once
- serialize migrations per-dbName to avoid open-version deadlock

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

#### indexeddb

- share single openIdb helper across storages

### Documentation

- add README files for new packages

### Chores

- fix merge issues after rebase and do a format

#### tabular-migrations

- final formatting + scripts/test.ts wiring

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

## 0.2.30

### Chores

- update peer deps

## 0.2.29

## 0.2.28

### Refactors

#### indexeddb

- move IndexedDB backends from @workglow/storage to @workglow/indexeddb

### Chores

- format
