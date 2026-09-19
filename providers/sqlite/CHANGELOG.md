# Changelog

## 0.6.7

### Features

- improve SQLite database extension loading handling errors

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

### Bug Fixes

#### storage

- stop connection transactions hanging and leaking uncommitted rows
- guard updateWhere's primary key on the transaction path

### Refactors

#### storage

- route the tx handle through the public methods

### Chores

- revert version change not made by bunset

## 0.4.9

### Bug Fixes

#### storage

- restore the deleteSearch guard on the transaction path
- align `in` with SQL on nulls, refuse a table-wide deleteSearch

## 0.4.8

### Bug Fixes

#### sqlite

- similaritySearch decoded an already-decoded vector (#889)

## 0.4.7

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

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

### Refactors

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

### Chores

- update deps

### Updated Dependencies

- `@types/better-sqlite3`: ^9.6.0

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

### Bug Fixes

#### storage

- share a connection mutex across storages bound to one handle

## 0.3.28

## 0.3.27

### Bug Fixes

#### storage

- honor clientProvidedKeys 'never' in bulk putBulk; refresh docs

### Performance

#### storage

- single-statement putBulk engine + SQLite backend

### Documentation

#### storage

- document single-statement putBulk and duplicate-key semantics

## Unreleased

### Refactors

#### sqlite

- `putBulk` now writes each chunk as a single multi-row `INSERT … RETURNING *`
  via the shared `BaseSqlTabularStorage` bulk engine, replacing the per-row
  insert loop. Atomicity, ordering (`result[i] === values[i]`), and deferred
  `put` events are preserved.

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

### Features

#### sqlite

- updateWhere CAS via UPDATE ... RETURNING

### Bug Fixes

#### storage

- updateWhere rejects patches that change a primary-key column
- make updateWhere single-row and consistent across backends

## 0.3.22

### Bug Fixes

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

## 0.3.21

## 0.3.20

## 0.3.19

### Features

#### sqlite

- set default busy_timeout and enable WAL mode for database connections

## 0.3.18

## 0.3.17

## 0.3.16

### Bug Fixes

#### providers/sqlite

- vector encoding inside withTransaction + nested-BEGIN deadlock (#594)

### Refactors

#### storage

- enhance unique index handling and event emission

## 0.3.15

### Features

#### storage

- add uniqueIndexes for DB-level UNIQUE constraints + dedup overlapping regular indexes (#593)

### Bug Fixes

- eslint fixes

#### providers/sqlite

- wrap putBulk vectors with vector_as_*() to match put (#590)

#### storage,indexeddb,postgres,sqlite

- cumulative vector-storage validation + atomicity hardening (#580/#581/#583/#584/#587) (#589)

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

- FetchUrl permanent codes + SQLite v4 + error-code registry (#518)

#### job-queue

- follow-up correctness fixes to PR #511 (#513)

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

### Tests

- add tabular-storage contract invariant suite across all backends (#510)

## 0.2.36

## 0.2.35

### Features

#### knowledge-base

- hybrid search via RRF over BM25F text index (#478)

### Bug Fixes

#### storage-migrations

- serialize concurrent runs and roll back partial SQLite schema (#485)

### Tests

#### sqlite-vector

- add @sqliteai/sqlite-vector to packages/test and fix ESM extension loading (#492)

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

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers

### Documentation

- add README files for new packages

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Chores

- fixup sqlite related packages

## 0.2.30

### Chores

- update peer deps

## 0.2.29

## 0.2.28

### Refactors

#### sqlite

- move SQLite backends from @workglow/storage to @workglow/sqlite

### Documentation

- update stale @workglow/ai-provider/* and @workglow/storage/* references in JSDoc
