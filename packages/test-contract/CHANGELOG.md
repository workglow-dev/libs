# Changelog

## Unreleased

### Features

#### test-contract

- publish the conformance suites as their own package. The 10 parameterized
  suites that were `packages/test/src/contract/` now ship from
  `@workglow/test-contract`, one subpath per contract, so an adapter written
  outside this repository inherits the assertions instead of re-deriving the
  contract by hand. `@workglow/test` — the concrete tests — stays private.
