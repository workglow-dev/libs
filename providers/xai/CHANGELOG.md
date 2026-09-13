# Changelog

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

#### pricing

- various fixes for pricing on models
- resolve rates from the live table and at the request's instant

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

### Features

#### pricing

- refactor model pricing resolution and enhance test coverage
- enhance model pricing structure and update cost estimation logic

## 0.4.7

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

### Bug Fixes

#### ai

- make the effort policies a gate rather than UI metadata

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

### Features

- thinking policy for models

## 0.3.46

### Features

#### schema

- enhance JSON schema handling for strict compatibility

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

### Bug Fixes

#### xai

- update import for ModelEffort from @workglow/ai/worker

### Refactors

#### providers

- import effort helpers from @workglow/ai/worker, and lint it

## 0.3.41

### Features

#### xai

- map model.effort and stamp Grok listing policies

### Chores

- update deps

## 0.3.40

## 0.3.39

### Features

- enhance model existence verification in AI provider streams
- enhance provisional usage reporting in AI provider streams

#### models

- update pricing and add new model for DeepSeek

### Bug Fixes

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

#### util

- last complete object wins when skipping JSON preamble (#718)

### Performance

#### util

- add an incremental partial-JSON stream parser (#681)

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

### Documentation

- fix workflow.add( -> workflow.addTask( in provider READMEs

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

## 0.3.26

### Bug Fixes

#### xai,openrouter

- guard chunk.choices access and downshift strict schema

## 0.3.25

### Features

#### providers

- add xAI (Grok) AI provider(#622)

## 0.3.24

### Features

- initial release: xAI (Grok) provider for `@workglow/ai`
