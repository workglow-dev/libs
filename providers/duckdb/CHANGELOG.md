# Changelog

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

_No changes in this package._

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

### Bug Fixes

#### storage

- stop connection transactions hanging and leaking uncommitted rows

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

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Features

- add withConnectionTransaction for sibling storages on one handle. (#842)

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

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

### Bug Fixes

#### duckdb

- keep putBulk idempotent on all-primary-key tables

### Performance

#### duckdb

- single-statement putBulk via shared bulk engine

### Documentation

#### storage

- document single-statement putBulk and duplicate-key semantics

## Unreleased

### Refactors

#### duckdb

- `putBulk` now writes each chunk as a single multi-row `INSERT … RETURNING *`
  via the shared `BaseSqlTabularStorage` bulk engine, replacing the per-row
  insert loop. Atomicity, ordering (`result[i] === values[i]`), and deferred
  `put` events are preserved.

## 0.3.26

### Features

#### storage

- add DuckDB tabular storage backend (@workglow/duckdb) (#635)
