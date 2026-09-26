# Changelog

## 0.6.8

_No changes in this package._

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

#### web-search

- add OpenAI, OpenRouter and Gemini grounded providers

### Bug Fixes

#### web-search

- address code review across the package and its adapters
- honour or refuse a named credential, stop registering providers on import, and keep two ports honest
- name a credential for a provider, fill Brave's open date bound, and thread abort
- make maxResults mean the same thing for every provider

#### pricing

- resolve rates from the live table and at the request's instant

#### openrouter,openai

- resolve the search API key explicitly and lazily

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

### Bug Fixes

#### ai

- stop reporting nullable-object schemas as OpenAI strict-compatible

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

### Refactors

#### providers

- import effort helpers from @workglow/ai/worker, and lint it

## 0.3.41

### Features

#### openai

- report effort policy and stamp listing records

## 0.3.40

## 0.3.39

### Features

- enhance model existence verification in AI provider streams
- enhance provisional usage reporting in AI provider streams

#### openai

- map model.effort to Responses reasoning

#### providers

- report cache-checkpoint warm-up token cost

### Bug Fixes

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

#### util

- last complete object wins when skipping JSON preamble (#718)

### Performance

#### util

- add an incremental partial-JSON stream parser (#681)

### Tests

- add unit tests for OpenAI reasoning and temperature coupling, and Postgres date handling

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

### Bug Fixes

#### openai

- surface silent Responses-API regressions from 0.3.26 (H2)

## 0.3.27

### Bug Fixes

Surface two silent Responses-API regressions from 0.3.26:

- `frequencyPenalty` and `presencePenalty` are dropped: the OpenAI Responses
  API does not accept them. `OpenAI_TextGeneration_Stream` now emits a
  `warn`-level log once per `(model, param)` per process when either is set.
- Structured generation `strict:true` downshifts to
  `isStrictCompatibleSchema(schema)`. Schemas that used to error out on the
  strict incompatibilities the Responses API rejects (`anyOf`, `$ref`, missing
  `additionalProperties:false`, unlisted required keys, etc.) now silently
  return non-conforming JSON — the `StructuredGenerationTask` consumer
  re-validates and may retry, but the provider-side strict guarantee is off.
  `OpenAI_StructuredGeneration_Stream` now emits a `warn`-level log once per
  model per process when the downshift fires, with the first non-strict reason.

Behavior is unchanged; only visibility. Callers that need the pre-0.3.26
behavior should pin `@workglow/openai@0.3.25` or route to a non-OpenAI
provider.

## 0.3.26

### Bug Fixes

#### xai,openrouter

- guard chunk.choices access and downshift strict schema

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

### Chores

- comment review pass across packages and providers

## 0.3.11

### Bug Fixes

#### storage,ai

- SQL operator allow-list + baseURL validation + credential-store passphrase sentinel (#546)

## 0.3.10

## 0.3.9

## 0.3.8

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

#### ai

- introduce capability-based dispatch (Phases 0-4)

### Bug Fixes

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

#### ai,providers,test

- Phase 5 review feedback and CI/test fixes

### Refactors

- shared promise on import for optional ai provider libs
- remove loadProviderSdk utility and streamline SDK loading in client implementations

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
- remove loadProviderSdk utility and streamline SDK loading in client implementations

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

### Refactors

#### ai-provider

- extract cloud provider mixin and OpenAI-shape chat helper (#459)

### Chores

- update peer deps

## 0.2.29

### Refactors

#### ai-provider

- enhance model search functionality

## 0.2.28

### Refactors

#### ai-provider

- final trim of vendor subpaths and SDK peers

#### openai

- move provider from @workglow/ai-provider to @workglow/openai

### Documentation

- update stale @workglow/ai-provider/* and @workglow/storage/* references in JSDoc
