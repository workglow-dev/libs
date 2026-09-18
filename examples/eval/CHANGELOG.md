# Changelog

## 0.6.5

### Features

- add image input and cached tokens to usage tracking

## 0.6.4

_No changes in this package._

## 0.6.3

### Features

- add @huggingface/transformers-structured-output dependency and update related packages

### Updated Dependencies

- `hyparquet`: ^1.31.0

## 0.6.2

_No changes in this package._

## 0.6.1

_No changes in this package._

## 0.6.0

### Updated Dependencies

- `hyparquet`: ^1.30.1

## 0.5.1

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

### Bug Fixes

#### util

- repair the Node worker path and drop the Bun worker fork

#### pricing

- resolve rates from the live table and at the request's instant

### Chores

- revert version change not made by bunset
- update bunset and its configuration and dependencies

### Updated Dependencies

- `hyparquet`: ^1.30.0

## 0.4.9

## 0.4.8

### Features

#### pricing

- refactor model pricing structure to support timing tiers and enhance cost estimation
- enhance model pricing structure and update cost estimation logic

## 0.4.7

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

### CI

- run ESLint in CI, behind a cached turbo task

## 0.4.4

### Updated Dependencies

- `hyparquet`: ^1.29.2

## 0.4.3

## 0.4.2

## 0.4.1

### Chores

- update deps

### Updated Dependencies

- `hyparquet`: ^1.29.1

## 0.4.0

## 0.3.49

### Features

#### eval

- make a sweep one graph, with each row visible while it runs
- give the eval CLI the console and run reporting

## 0.3.48

## 0.3.47

## 0.3.46

### Features

#### tests

- add credit exhaustion handling and skip logic for provider tests

## 0.3.45

### Bug Fixes

#### eval

- restore grok-4.5 pricing

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

### Chores

- update deps

### Updated Dependencies

- `hyparquet`: ^1.28.2

## 0.3.40

## 0.3.39

### Features

#### models

- update pricing and add new model for DeepSeek

#### eval-example

- record and rank token usage and cost

### Bug Fixes

#### eval

- price the gpt-5.6 family, drop the bogus Anthropic max_tokens

### Tests

- run tests through Turbo and per-package vitest projects

#### eval-example

- cover the token-accounting logic the crux review flagged

### Documentation

#### eval-example

- stop the rate card asserting a provenance it lacks

### Chores

- update CodeMirror dependencies and improve TypeScript configuration
- upgrade to catalog for many deps and update the deps themselves

### Updated Dependencies

- `commander`: catalog:
- `hyparquet`: ^1.28.1

## 0.3.38

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

### Features

#### deepseek

- add DeepSeek AI provider

## 0.3.32

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `hyparquet`: ^1.27.1

## 0.3.30

### Chores

- update deps

### Updated Dependencies

- `hyparquet`: ^1.27.0

## 0.3.29

## 0.3.28

## 0.3.27

## 0.3.26

### Features

- add Workglow Eval: CLI harness for model evaluation on HuggingFace datasets (#636)
