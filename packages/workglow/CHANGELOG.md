# workglow

## 0.6.8

### Bug Fixes

#### workglow

- make judgment.systemone reachable from the meta-package

### Chores

#### workglow

- wire @workglow/a2ui into the meta-package and the guide

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

### Features

#### cli,workglow

- serve headless, refuse a model-less agent, and share the serve helpers

## 0.6.0

### Updated Dependencies

- `tslog`: ^5.2.0

## 0.5.1

_No changes in this package._

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

## 0.4.7

## 0.4.6

### Features

- migrate SQLite driver from better-sqlite3 to node:sqlite (#710)

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

## 0.3.46

### Features

#### triggers

- add the triggers package with cron, interval, and polling triggers

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

## 0.3.39

### Features

#### ai

- add a ./test entry and drop _testOnly from the public API

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

### Documentation

#### build

- correct the surviving bun-condition count and pin it with a test (#716)

## 0.3.38

### Bug Fixes

#### build

- declare the meta-package's runtime dependency on its deps' JS

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

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `tslog`: ^5.1.0

## 0.3.26

### Features

#### storage

- add DuckDB tabular storage backend (@workglow/duckdb) (#635)

### Chores

#### deps

- update @cloudflare/workers-types to 5.x and tslog to 5.x

### Updated Dependencies

- `tslog`: ^5.0.0

## 0.3.25

### Features

- add node-llama-cpp provider to workglow meta-package (#629)
- add OpenRouter provider for @workglow/ai (#626)

#### providers

- add xAI (Grok) AI provider(#622)

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Updated Dependencies

- `tslog`: ^4.11.0

## 0.3.23

### Chores

- update deps

### Updated Dependencies

- `tslog`: ^4.11.0

## 0.3.22

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

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

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

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

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Chores

- release 30 packages
- release 30 packages
- fixup some wrong links after rename

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

## 0.2.34

## 0.2.33

### Chores

- fixup some wrong links after rename

## 0.2.32

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers

#### browser-control

- split backends into per-vendor provider packages

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Refactors

#### chrome-ai

- rename @workglow/chrome to @workglow/chrome-ai (#457)

## 0.2.29

## 0.2.28

### Refactors

#### workglow

- drop optional vendor SDK peer dependencies

#### tasks

- strip MCP and browser-control auto-registration from runtime entries

#### mcp

- move MCP tasks and util from @workglow/tasks to @workglow/mcp

#### browser-control

- move browser-control backends from @workglow/tasks to @workglow/browser-control

#### javascript

- move JavaScriptTask + interpreter from @workglow/tasks to @workglow/javascript

#### ai-provider

- final trim of vendor subpaths and SDK peers

#### chrome

- move provider from @workglow/ai-provider to @workglow/chrome

#### tf-mediapipe

- move provider from @workglow/ai-provider to @workglow/tf-mediapipe

#### huggingface-inference

- move provider from @workglow/ai-provider to @workglow/huggingface-inference

#### huggingface-transformers

- move provider from @workglow/ai-provider to @workglow/huggingface-transformers

#### ollama

- move provider from @workglow/ai-provider to @workglow/ollama

#### google-gemini

- move provider from @workglow/ai-provider to @workglow/google-gemini

#### openai

- move provider from @workglow/ai-provider to @workglow/openai

#### anthropic

- move provider from @workglow/ai-provider to @workglow/anthropic

#### storage

- break temporary storage→job-queue cycle now that vendor queue impls are out

### Chores

- code-review fixes (round 2)

## 0.2.27

## 0.2.26

## 0.2.25

## 0.2.24

## 0.2.23

## 0.2.22

## 0.2.21

## 0.2.20

## 0.2.19

## 0.2.18

## 0.2.17

## 0.2.16

### Chores

- release 12 packages

## 0.2.15

## 0.2.14

## 0.2.13

## 0.2.12

## 0.2.11

## 0.2.10

## 0.2.9

## 0.2.8

## 0.2.7

## 0.2.6

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)

### Chores

- release 12 packages

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)

## 0.1.2

## 0.1.1

## 0.1.0

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### storage

- move @workglow/sqlite package into @workglow/storage/sqlite and add @workglow/storage/postgresql

#### example-web

- refactor storage implementation and update model imports

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

### Features

#### workglow

- implement custom build script and update package.json for improved build process
- add worker entry points for browser, Bun, and Node environments in consolidated workglow bundle

#### task-graph

- integrate Chrome DevTools formatters and update imports into task-graph, which is what it is used for. done moving this around now.

#### cli

- enhance CLI integration with task and workflow commands

#### storage

- SQLite: **`await Sqlite.init()`** before opening a database; same entrypoint on Node, Bun, and browser (re-exported from `workglow`)

### Refactors

#### debug

- remove @workglow/debug package and integrate debug utilities into @workglow/util

## 0.0.124

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

### Refactors

- update package exports to use source files instead of dist
- split the sdk off to worker only
- reorg ai-provider a bit more
- ai provider

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)

### Chores

- release 14 packages

## 0.0.118

### Features

- add chrome web browser provider (#303)

## 0.0.117

## 0.0.116

### Refactors

- update type imports and SDK loading in AI provider modules

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

## 0.0.109

## 0.0.108

## 0.0.107

### Bug Fixes

- enhance HuggingFace Transformers provider with streaming and reactive tasks support

## 0.0.106

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/ai@0.0.105
  - @workglow/ai-provider@0.0.105
  - @workglow/dataset@0.0.105
  - @workglow/debug@0.0.105
  - @workglow/job-queue@0.0.105
  - @workglow/sqlite@0.0.105
  - @workglow/storage@0.0.105
  - @workglow/task-graph@0.0.105
  - @workglow/tasks@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/ai@0.0.104
  - @workglow/ai-provider@0.0.104
  - @workglow/dataset@0.0.104
  - @workglow/debug@0.0.104
  - @workglow/job-queue@0.0.104
  - @workglow/sqlite@0.0.104
  - @workglow/task-graph@0.0.104
  - @workglow/tasks@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/ai@0.0.103
  - @workglow/ai-provider@0.0.103
  - @workglow/dataset@0.0.103
  - @workglow/debug@0.0.103
  - @workglow/job-queue@0.0.103
  - @workglow/sqlite@0.0.103
  - @workglow/storage@0.0.103
  - @workglow/task-graph@0.0.103
  - @workglow/tasks@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/ai@0.0.102
  - @workglow/ai-provider@0.0.102
  - @workglow/dataset@0.0.102
  - @workglow/debug@0.0.102
  - @workglow/job-queue@0.0.102
  - @workglow/sqlite@0.0.102
  - @workglow/storage@0.0.102
  - @workglow/task-graph@0.0.102
  - @workglow/tasks@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/task-graph@0.0.101
  - @workglow/tasks@0.0.101
  - @workglow/ai@0.0.101
  - @workglow/ai-provider@0.0.101
  - @workglow/dataset@0.0.101
  - @workglow/debug@0.0.101
  - @workglow/job-queue@0.0.101
  - @workglow/sqlite@0.0.101
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/ai@0.0.100
  - @workglow/ai-provider@0.0.100
  - @workglow/dataset@0.0.100
  - @workglow/debug@0.0.100
  - @workglow/job-queue@0.0.100
  - @workglow/sqlite@0.0.100
  - @workglow/storage@0.0.100
  - @workglow/task-graph@0.0.100
  - @workglow/tasks@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/ai@0.0.99
  - @workglow/ai-provider@0.0.99
  - @workglow/dataset@0.0.99
  - @workglow/debug@0.0.99
  - @workglow/job-queue@0.0.99
  - @workglow/sqlite@0.0.99
  - @workglow/storage@0.0.99
  - @workglow/task-graph@0.0.99
  - @workglow/tasks@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/ai@0.0.98
  - @workglow/ai-provider@0.0.98
  - @workglow/dataset@0.0.98
  - @workglow/debug@0.0.98
  - @workglow/job-queue@0.0.98
  - @workglow/sqlite@0.0.98
  - @workglow/storage@0.0.98
  - @workglow/task-graph@0.0.98
  - @workglow/tasks@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/ai@0.0.97
  - @workglow/ai-provider@0.0.97
  - @workglow/dataset@0.0.97
  - @workglow/debug@0.0.97
  - @workglow/job-queue@0.0.97
  - @workglow/sqlite@0.0.97
  - @workglow/storage@0.0.97
  - @workglow/task-graph@0.0.97
  - @workglow/tasks@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/ai@0.0.96
  - @workglow/ai-provider@0.0.96
  - @workglow/dataset@0.0.96
  - @workglow/debug@0.0.96
  - @workglow/job-queue@0.0.96
  - @workglow/sqlite@0.0.96
  - @workglow/storage@0.0.96
  - @workglow/task-graph@0.0.96
  - @workglow/tasks@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/ai@0.0.95
  - @workglow/ai-provider@0.0.95
  - @workglow/dataset@0.0.95
  - @workglow/debug@0.0.95
  - @workglow/job-queue@0.0.95
  - @workglow/sqlite@0.0.95
  - @workglow/storage@0.0.95
  - @workglow/task-graph@0.0.95
  - @workglow/tasks@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/ai-provider@0.0.94
  - @workglow/task-graph@0.0.94
  - @workglow/job-queue@0.0.94
  - @workglow/dataset@0.0.94
  - @workglow/storage@0.0.94
  - @workglow/sqlite@0.0.94
  - @workglow/debug@0.0.94
  - @workglow/tasks@0.0.94
  - @workglow/util@0.0.94
  - @workglow/ai@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/ai-provider@0.0.93
  - @workglow/task-graph@0.0.93
  - @workglow/job-queue@0.0.93
  - @workglow/dataset@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/sqlite@0.0.93
  - @workglow/debug@0.0.93
  - @workglow/tasks@0.0.93
  - @workglow/util@0.0.93
  - @workglow/ai@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/ai-provider@0.0.92
  - @workglow/task-graph@0.0.92
  - @workglow/job-queue@0.0.92
  - @workglow/dataset@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/sqlite@0.0.92
  - @workglow/debug@0.0.92
  - @workglow/tasks@0.0.92
  - @workglow/util@0.0.92
  - @workglow/ai@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/ai-provider@0.0.91
  - @workglow/task-graph@0.0.91
  - @workglow/util@0.0.91
  - @workglow/ai@0.0.91
  - @workglow/dataset@0.0.91
  - @workglow/debug@0.0.91
  - @workglow/job-queue@0.0.91
  - @workglow/sqlite@0.0.91
  - @workglow/storage@0.0.91
  - @workglow/tasks@0.0.91
