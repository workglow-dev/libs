# Changelog

## 0.6.8

### Refactors

- remove deprecated DeepSeek v4.1 references

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

### Bug Fixes

#### pricing

- resolve rates from the live table and at the request's instant

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

### Features

#### pricing

- refactor model pricing structure to support timing tiers and enhance cost estimation
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

### Refactors

#### providers

- import effort helpers from @workglow/ai/worker, and lint it

## 0.3.41

### Features

#### ai-providers

- stamp effort_options from class policies

## 0.3.40

## 0.3.39

### Features

- enhance model existence verification in AI provider streams
- enhance provisional usage reporting in AI provider streams

#### models

- update pricing and add new model for DeepSeek

#### deepseek

- map model.effort to reasoning_allowance

### Bug Fixes

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

#### deepseek

- map the stated cache-miss count to disjoint input

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

### Bug Fixes

#### deepseek

- make tool_choice violations actually retryable

### Refactors

- update maxTokens description and implement reasoning allowances

## 0.3.33

### Features

#### deepseek

- add DeepSeek AI provider

### Bug Fixes

#### deepseek

- enforce a forcing tool_choice client-side
- correct json-mode and tool_choice for the real API

### Documentation

- fix workflow.add( -> workflow.addTask( in provider READMEs

## 0.3.32

### Features

#### deepseek

- Initial DeepSeek provider: text generation, tool calling, structured (JSON)
  generation, rewriting, summarization, token counting, and model search/info
  against the OpenAI-compatible `https://api.deepseek.com` API.
