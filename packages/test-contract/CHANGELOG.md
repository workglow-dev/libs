# Changelog

## 0.6.8

### Bug Fixes

#### providers

- stop four run-fns accumulating on finish, and keep v3's reasoning off the text port

### Tests

#### contract

- publish the tabular CRUD and job-queue suites

#### ai-provider

- record the per-token image cards, and check the tables

## 0.6.7

_No changes in this package._

## 0.6.6

_No changes in this package._

## 0.6.5

### Features

- add image input and cached tokens to usage tracking

## 0.6.4

_No changes in this package._

## 0.6.3

_No changes in this package._

## 0.6.2

### Bug Fixes

#### test-contract

- stop expected-fail tests reporting as flaky

## 0.6.1

### Features

#### test-contract

- publish the conformance suites so downstream adapters can inherit them

### Tests

#### test-contract

- close four gaps a review found in the new suites

#### web-search

- hold all seven providers to the capability record they publish

#### storage

- hold the two join strategies to the same answer

## Unreleased

### Features

#### test-contract

- publish the conformance suites as their own package. The 10 parameterized
  suites that were `packages/test/src/contract/` now ship from
  `@workglow/test-contract`, one subpath per contract, so an adapter written
  outside this repository inherits the assertions instead of re-deriving the
  contract by hand. `@workglow/test` — the concrete tests — stays private.
- `runWebSearchProviderConformance` (`./web-search`): `IWebSearchProvider` had
  seven implementations across five packages and no shared assertions. Derived
  from the capability record rather than written per provider.
- `runTabularJoinContract` (`./tabular-storage`) gains `join strategy parity`
  and `join bounded left read`, and moves here from `@workglow/test`.
