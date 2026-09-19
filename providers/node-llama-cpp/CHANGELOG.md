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

## 0.4.8

### Features

#### pricing

- enhance model pricing structure and update cost estimation logic

## 0.4.7

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

### Bug Fixes

#### node-llama-cpp

- stop embedding GGUFs advertising chat-session capabilities

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

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

### Chores

- format changes

## 0.3.39

### Features

- enhance usage tracking in AI providers

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

### Bug Fixes

#### util,llamacpp

- tenant-scope id and per-session mutex prep

## 0.3.28

## 0.3.27

## 0.3.26

### Bug Fixes

#### node-llama-cpp

- address structured generation review feedback
- fresh context per structured generation
- eviction disposes embedding, broaden isVramError, retry embedding create
- address review feedback on VRAM/LRU/sequence handling
- close sequence-reclaim race and auto-evict on VRAM pressure

#### node-llama-cpp,huggingface-transformers

- concurrency + sequence-leak + bounded pipeline cache (#634)

### Chores

#### node-llama-cpp

- clarify allocation and sequence error matching constants

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

## 0.3.22

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

### Bug Fixes

- eslint fixes

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

### Features

- add provider runtime metadata: supportsServer and isAvailable() (#538)

## 0.3.7

## 0.3.6

## 0.3.5

### Bug Fixes

- Chrome-ai (#514)

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

## 0.2.36

## 0.2.35

### Features

#### tests

- add comprehensive tests for AiChatTask and AiChatWithKbTask

#### ai,test,ci

- bridgeProgress utility and large-model integration test harness

### Bug Fixes

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

#### ai,providers,test

- Phase 5 review feedback and CI/test fixes

### Refactors

- shared promise on import for optional ai provider libs

#### ai

- finalize Promise+emit migration and cleanup
- migrate execution path to Promise+emit shape

#### providers

- migrate all providers to AiProviderRunFnRegistration[] (Phase 5)

### Chores

- release 30 packages
- release 30 packages
- fixup comment references to things renamed
- fixup some wrong links after rename

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

## 0.2.34

## 0.2.33

### Refactors

- shared promise on import for optional ai provider libs

### Chores

- fixup comment references to things renamed
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

#### node-llama-cpp

- move provider from @workglow/ai-provider to @workglow/node-llama-cpp

### Documentation

- update stale @workglow/ai-provider/* and @workglow/storage/* references in JSDoc
