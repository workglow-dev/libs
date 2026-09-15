# Changelog

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

#### supabase

- keep deleteSearch's filter builder off the generic path

#### test

- close the gaps the Turbo/projects wiring opened

### Refactors

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

### Bug Fixes

#### supabase

- quote the PK column list in CREATE TABLE bootstrap

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

### Bug Fixes

#### storage

- BigInt-safe primary-key fingerprint in bulk paths

## 0.3.28

## 0.3.27

### Bug Fixes

#### storage

- ensure correct typing for primary key fingerprint in SupabaseTabularStorage

#### supabase

- collision-safe composite-key fingerprint in putBulk dedup
- dedup duplicate primary keys in putBulk batches

### Documentation

#### storage

- document single-statement putBulk and duplicate-key semantics

## Unreleased

### Bug Fixes

#### supabase

- `putBulk` now deduplicates duplicate primary keys within a batch
  (last-write-wins) before its single upsert, returns the final committed row
  for every duplicate position, and emits one `put` event per distinct
  committed row.

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

### Features

#### supabase

- updateWhere CAS via filtered update().select()

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

## 0.3.18

## 0.3.17

## 0.3.16

### Refactors

#### storage

- enhance unique index handling and event emission

## 0.3.15

### Bug Fixes

- eslint fixes

#### storage,indexeddb,postgres,sqlite

- cumulative vector-storage validation + atomicity hardening (#580/#581/#583/#584/#587) (#589)

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

#### supabase

- add Supabase vector storage with pgvector support (#578)

## 0.3.13

## 0.3.12

### Refactors

- rework delete events

### Chores

- comment review pass across packages and providers

## 0.3.11

## 0.3.10

### Features

#### supabase

- introduce error handling functions for PostgREST interactions

### Refactors

#### supabase

- streamline table existence checks in SupabaseQueueStorage, SupabaseRateLimiterStorage, and SupabaseTabularStorage

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

## 0.2.30

### Chores

- update peer deps

## 0.2.29

## 0.2.28

### Refactors

#### supabase

- move Supabase backends from @workglow/storage to @workglow/supabase

### Chores

- format
