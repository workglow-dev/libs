# Changelog

## 0.6.1

_No changes in this package._

## 0.6.0

### Bug Fixes

#### pricing

- stop reporting an unpriced rate as free (#930)

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

- various fixes for pricing on models

#### openrouter,openai

- resolve the search API key explicitly and lazily

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

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

#### openrouter

- map model.effort into reasoning extras

### Bug Fixes

- improve usage tracking

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

- add OpenRouter provider for @workglow/ai (#626)
