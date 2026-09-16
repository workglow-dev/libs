# Changelog

## 0.6.3

### Refactors

#### a2ui

- build entries flat into dist, as every other package does

## 0.6.2

### Features

#### a2ui

- resolve bindings, and refuse a function the catalog omits
- add the @workglow/a2ui workspace

### Bug Fixes

#### a2ui

- let the empty pointer name the root, as everything else already does
- stop a resolved bag being re-prototyped, and refuse what the fold would throw on
- close the holes a review found, including two real ones
- check an email without a regex that backtracks
- never render a bound object as [object Object]
- carry the catalog's defaults, so a renderer cannot invent its own
