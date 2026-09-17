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

#### anthropic

- add grounded web-search provider subpath

### Bug Fixes

#### web-search

- address code review across the package and its adapters
- honour or refuse a named credential, stop registering providers on import, and keep two ports honest
- name a credential for a provider, fill Brave's open date bound, and thread abort
- let a provider declare that it takes one domain list, not both
- make maxResults mean the same thing for every provider
- keep test declarations out of the published tarball
- correct rate-limiter claim and gate the grounded answer

#### pricing

- resolve rates from the live table and at the request's instant

#### anthropic

- give the package a test script so its tests actually run

### Documentation

- document @workglow/web-search in CLAUDE.md

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

### Bug Fixes

#### ai

- enhance model effort validation in Anthropic Thinking

## 0.3.46

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

### Refactors

#### providers

- import effort helpers from @workglow/ai/worker, and lint it

## 0.3.41

### Features

#### ai-providers

- stamp effort_options from class policies

## 0.3.40

### Performance

#### ai

- stream tool-call argument JSON instead of re-parsing the buffer

### Chores

- format changes

## 0.3.39

### Features

- enhance model existence verification in AI provider streams

#### anthropic

- honor model.effort for extended/adaptive thinking

#### providers

- report cache-checkpoint warm-up token cost
- emit cumulative usage snapshots mid-stream

### Bug Fixes

#### anthropic

- keep an in-range top_p under legacy extended thinking
- build a legal request under legacy extended thinking

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

#### util

- last complete object wins when skipping JSON preamble (#718)

### Refactors

#### tests

- streamline model info test function calls (fix type errors)

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

### Bug Fixes

#### anthropic

- stop sending sampling params to models that reject them

### Refactors

#### anthropic

- derive the max_tokens schema default from the constant

## Unreleased

### Bug Fixes

- stop sending `temperature` / `top_p` to Claude models that reject them. Recent
  models (`claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, …) return HTTP 400 for sampling parameters, which maps to a
  non-retryable `PermanentJobError` — so text generation and tool calling failed
  outright on those models whenever a caller set either field. The parameters are
  now forwarded only for model ids belonging to a generation known to accept them
  (Claude 4.6 and older); anything else drops them with a single warning naming
  what was dropped. `provider_config.sampling_params` (`"send"` / `"omit"`)
  overrides the decision for a model whose id shape is misclassified.
- infer the full capability set for the Claude 5 family (`claude-opus-5`,
  `claude-sonnet-5`, `claude-haiku-5`) and the fable / mythos lines. Model search
  emits an empty `capabilities` array, so without this those models resolved to
  meta-ops only and could not run text generation at all.

### Refactors

- refresh the model-search fallback list: drop the retired
  `claude-3-5-sonnet-20241022` / `claude-3-5-haiku-20241022` ids (both 404) and
  offer the current Claude 5 and 4.x models, newest first.
- raise the `provider_config.max_tokens` schema default from 1024 to 16384 to
  match `ANTHROPIC_DEFAULT_MAX_TOKENS`. Existing records are unaffected; newly
  created records will carry the higher ceiling.

## 0.3.34

### Refactors

- update maxTokens description and implement reasoning allowances

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

#### ai,test,ci

- bridgeProgress utility and large-model integration test harness

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

#### anthropic

- move provider from @workglow/ai-provider to @workglow/anthropic

### Documentation

- update stale @workglow/ai-provider/* and @workglow/storage/* references in JSDoc
