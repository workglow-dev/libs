# @workglow/web

## 0.6.5

_No changes in this package._

## 0.6.4

_No changes in this package._

## 0.6.3

### Features

- add @huggingface/transformers-structured-output dependency and update related packages

## 0.6.2

_No changes in this package._

## 0.6.1

### Chores

- update deps

### Updated Dependencies

- `@codemirror/state`: 6.7.5
- `@codemirror/view`: 6.43.12

## 0.6.0

### Updated Dependencies

- `react-dom`: ^19.3.0
- `tailwind-merge`: ^3.7.0
- `@types/react-dom`: ^19.3.0
- `vite`: ^8.3.0

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
- update bunset and its configuration and dependencies

### Updated Dependencies

- `react-resizable-panels`: ^4.12.4

## 0.4.9

### Chores

- update dependencies

### Updated Dependencies

- `@codemirror/state`: 6.7.4
- `@codemirror/view`: 6.43.11
- `@types/react-dom`: ^19.2.7

## 0.4.6

### Chores

- update deps
- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

### Updated Dependencies

- `@xyflow/react`: =12.11.6

## 0.4.4

### Bug Fixes

#### tasks

- make dropping the filesystem tasks a compile-time decision

### Updated Dependencies

- `@codemirror/state`: 6.7.2
- `@codemirror/view`: 6.43.10
- `@xyflow/react`: =12.11.5
- `@vitejs/plugin-react`: ^6.1.1

## 0.4.3

### Chores

- revent @xyflow/react update
- update deps

### Updated Dependencies

- `@xyflow/react`: =12.11.3

## 0.4.1

### Chores

- update deps

### Updated Dependencies

- `@types/react-dom`: ^19.2.5

## 0.3.48

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.1.0
- `vite`: ^8.2.2

## 0.3.47

### Chores

- update deps

### Updated Dependencies

- `@codemirror/view`: 6.43.9
- `react-resizable-panels`: ^4.12.3

## 0.3.41

### Chores

- update deps

### Updated Dependencies

- `rollup-plugin-visualizer`: ^7.1.1

## 0.3.40

### Chores

- format changes

## 0.3.39

### Features

#### web-example

- show the run's cumulative token total

### Bug Fixes

- improve usage tracking

#### task-graph,ai

- route a checkpoint's storage charge into the run total

#### task-graph

- roll usage up by task and by model, not one slice each

### Chores

- untrack examples/web/tsconfig.norefs.tsbuildinfo
- update deps
- add Lezer dependencies and update Vite configuration
- update CodeMirror dependencies and improve TypeScript configuration
- upgrade to catalog for many deps and update the deps themselves
- update deps

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

### Updated Dependencies

- `@xyflow/react`: ^12.11.3
- `react`: catalog:
- `@types/react`: catalog:
- `vite`: ^8.2.1

## 0.3.37

### Bug Fixes

- data-URI decode order, own() tracking for functions, UI wiring

#### web

- release a disowned subtask's listeners in TaskNode

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.18
- `@types/react-dom`: ^19.2.4

## 0.3.30

### Chores

- update deps

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.0.5
- `vite`: ^8.2.0

## 0.3.29

### Chores

- update deps

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.0.4

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `react`: ^19.2.8
- `react-dom`: ^19.2.8
- `@tailwindcss/vite`: ^4.3.3
- `tailwindcss`: ^4.3.3
- `vite`: ^8.1.5

## 0.3.26

### Chores

- update deps

### Updated Dependencies

- `react-resizable-panels`: ^4.12.2

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Updated Dependencies

- `@uiw/codemirror-theme-vscode`: ^4.25.11
- `@uiw/react-codemirror`: ^4.25.11
- `@xyflow/react`: ^12.11.2
- `react-resizable-panels`: ^4.12.1
- `vite`: ^8.1.4

## 0.3.23

### Chores

- update deps

### Updated Dependencies

- `@uiw/codemirror-theme-vscode`: ^4.25.11
- `@uiw/react-codemirror`: ^4.25.11
- `@xyflow/react`: ^12.11.2
- `react-resizable-panels`: ^4.12.1
- `vite`: ^8.1.4

## 0.3.22

### Chores

- update deps

### Updated Dependencies

- `react-icons`: ^5.7.0
- `react-resizable-panels`: ^4.12.0
- `@tailwindcss/vite`: ^4.3.2
- `tailwindcss`: ^4.3.2
- `vite`: ^8.1.3

## 0.3.20

### Chores

- update deps

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.0.3
- `vite`: ^8.1.0

## 0.3.17

### Updated Dependencies

- `@xyflow/react`: ^12.11.1

## 0.3.16

### Refactors

#### storage

- enhance unique index handling and event emission

## 0.3.15

### Bug Fixes

- eslint fixes

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Chores

- update deps

### Updated Dependencies

- `@tailwindcss/vite`: ^4.3.1
- `tailwindcss`: ^4.3.1

## 0.3.13

### Refactors

- unify task output storage implementation

## 0.3.12

### Chores

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.17

## 0.3.10

### Chores

- update deps

### Updated Dependencies

- `@xyflow/react`: ^12.11.0
- `react`: ^19.2.7
- `react-dom`: ^19.2.7
- `@types/react`: ^19.2.16
- `vite`: ^8.0.16

## 0.3.6

### Chores

- update deps, turn off preview libs for now

### Updated Dependencies

- `react-resizable-panels`: ^4.11.2

## 0.3.2

### Chores

- update deps

### Updated Dependencies

- `@uiw/codemirror-theme-vscode`: ^4.25.10
- `@uiw/react-codemirror`: ^4.25.10
- `vite`: ^8.0.14

## 0.3.0

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

### Bug Fixes

- update web example

### Chores

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.15

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

### Chores

- update deps

#### deps-dev

- bump vite from 8.0.12 to 8.0.13

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.0.2
- `vite`: ^8.0.13

## 0.2.35

### Refactors

#### ai

- finalize Promise+emit migration and cleanup

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Chores

- release 30 packages
- release 30 packages

#### dependencies

- update package versions and lockfile, and remove bun tests from CI

### CI

- empty commit to retrigger main Build & Test

### Updated Dependencies

- `react-resizable-panels`: ^4.11.1
- `tailwind-merge`: ^3.6.0
- `@tailwindcss/vite`: ^4.3.0
- `tailwindcss`: ^4.3.0
- `vite`: ^8.0.12

## 0.2.34

### Updated Dependencies

- `tailwind-merge`: ^3.6.0
- `@tailwindcss/vite`: ^4.3.0
- `tailwindcss`: ^4.3.0

## 0.2.32

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai

### Chores

- update deps

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

### Updated Dependencies

- `react`: ^19.2.6
- `react-dom`: ^19.2.6
- `vite`: ^8.0.11

## 0.2.28

### Bug Fixes

- examples imports for moved symbols

### Refactors

#### tf-mediapipe

- move provider from @workglow/ai-provider to @workglow/tf-mediapipe

#### huggingface-transformers

- move provider from @workglow/ai-provider to @workglow/huggingface-transformers

## 0.2.25

### Chores

- update deps

### Updated Dependencies

- `react-resizable-panels`: ^4.11.0

## 0.2.21

### Features

#### examples

- render indeterminate progress and phase labels

#### task-graph

- indeterminate progress and StreamPhase events

#### ai

- image generation pipeline with ImageValue boundary

## 0.2.16

### Chores

- release 12 packages
- update deps

### Updated Dependencies

- `@tailwindcss/vite`: ^4.2.4
- `tailwindcss`: ^4.2.4
- `vite`: ^8.0.10

## 0.2.15

### Chores

- update deps

### Updated Dependencies

- `@tailwindcss/vite`: ^4.2.4
- `tailwindcss`: ^4.2.4
- `vite`: ^8.0.10

## 0.2.12

### Chores

- update dependencies for improved compatibility

### Updated Dependencies

- `@tailwindcss/vite`: ^4.2.3
- `tailwindcss`: ^4.2.3
- `vite`: ^8.0.9

## 0.2.6

### Chores

- update dependencies in package.json and bun.lock

### Updated Dependencies

- `react-resizable-panels`: ^4.10.0

## 0.2.1

### Chores

- update dependencies

### Updated Dependencies

- `vite`: ^8.0.8

## 0.2.0

### Features

- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)

### Chores

- release 12 packages
- format changes

### Updated Dependencies

- `react`: ^19.2.5
- `react-dom`: ^19.2.5

## 0.1.3

### Features

- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)

### Chores

- format changes

### Updated Dependencies

- `react`: ^19.2.5
- `react-dom`: ^19.2.5

## 0.1.2

### Updated Dependencies

- `vite`: ^8.0.5

## 0.1.1

### Refactors

- update ResizablePanel components for improved clarity and functionality

### Chores

#### dependencies

- update Tailwind CSS and related configurations

### Updated Dependencies

- `react-resizable-panels`: ^4.8.0
- `tailwind-merge`: ^3.3.0
- `tailwindcss`: ^4.1.7

## 0.1.0

### Features

#### queue-status

- remove JobQueueTask from the task class heirarchy

#### docs

- update model configurations to use structured object format

### Chores

- remove unnecessary comments that restate code or reference commits
- update package dependencies (transformers to version 4.0.0-next.9)

#### dependencies

- remove react-hotkeys-hook from package configurations
- update package versions for improved compatibility and features

### Updated Dependencies

- `@uiw/codemirror-theme-vscode`: ^4.25.9
- `@uiw/react-codemirror`: ^4.25.9
- `@xyflow/react`: ^12.10.2
- `vite`: ^8.0.3

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### storage

- move @workglow/sqlite package into @workglow/storage/sqlite and add @workglow/storage/postgresql

#### example-web

- refactor storage implementation and update model imports

## 0.0.125

### Features

#### task-graph

- integrate Chrome DevTools formatters and update imports into task-graph, which is what it is used for. done moving this around now.

### Refactors

#### debug

- remove @workglow/debug package and integrate debug utilities into @workglow/util

### Chores

#### dependencies

- update various package versions for improved stability and features

### Updated Dependencies

- `vite`: ^8.0.2

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Refactors

- split the sdk off to worker only
- reorg ai-provider a bit more
- ai provider

#### ai-provider

- introduce queued providers for various AI models

### Chores

- update dependencies and enhance Vite configuration
- makes example/web build types and code at the same time
- add rollup-plugin-visualizer for bundle analysis
- add @typescript/native-preview package and make updates for tsgo

### Updated Dependencies

- `@vitejs/plugin-react`: ^6.0.1

## 0.0.121

### Chores

- updated "@huggingface/transformers" to version 4.0.0-next.8.

### Updated Dependencies

- `vite`: ^8.0.1

## 0.0.119

### Features

- add chrome web browser provider (#303)

### Chores

- update dependencies including upgrade to vite 8
- release 14 packages

### Updated Dependencies

- `vite`: ^8.0.0

## 0.0.118

### Features

- add chrome web browser provider (#303)

## 0.0.116

### Bug Fixes

- update ONNX model ID and dtype across multiple files

## 0.0.114

### Updated Dependencies

- `@uiw/codemirror-theme-vscode`: ^4.25.7
- `@uiw/react-codemirror`: ^4.25.7
- `react-icons`: ^5.6.0
- `postcss`: 8.5.8

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/ai@0.0.105
  - @workglow/ai-provider@0.0.105
  - @workglow/debug@0.0.105
  - @workglow/job-queue@0.0.105
  - @workglow/sqlite@0.0.105
  - @workglow/storage@0.0.105
  - @workglow/task-graph@0.0.105
  - @workglow/tasks@0.0.105
  - @workglow/test@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/ai@0.0.104
  - @workglow/ai-provider@0.0.104
  - @workglow/debug@0.0.104
  - @workglow/job-queue@0.0.104
  - @workglow/sqlite@0.0.104
  - @workglow/task-graph@0.0.104
  - @workglow/tasks@0.0.104
  - @workglow/test@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/ai@0.0.103
  - @workglow/ai-provider@0.0.103
  - @workglow/debug@0.0.103
  - @workglow/job-queue@0.0.103
  - @workglow/sqlite@0.0.103
  - @workglow/storage@0.0.103
  - @workglow/task-graph@0.0.103
  - @workglow/tasks@0.0.103
  - @workglow/test@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/ai@0.0.102
  - @workglow/ai-provider@0.0.102
  - @workglow/debug@0.0.102
  - @workglow/job-queue@0.0.102
  - @workglow/sqlite@0.0.102
  - @workglow/storage@0.0.102
  - @workglow/task-graph@0.0.102
  - @workglow/tasks@0.0.102
  - @workglow/test@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/task-graph@0.0.101
  - @workglow/tasks@0.0.101
  - @workglow/test@0.0.101
  - @workglow/ai@0.0.101
  - @workglow/ai-provider@0.0.101
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
  - @workglow/debug@0.0.100
  - @workglow/job-queue@0.0.100
  - @workglow/sqlite@0.0.100
  - @workglow/storage@0.0.100
  - @workglow/task-graph@0.0.100
  - @workglow/tasks@0.0.100
  - @workglow/test@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/ai@0.0.99
  - @workglow/ai-provider@0.0.99
  - @workglow/debug@0.0.99
  - @workglow/job-queue@0.0.99
  - @workglow/sqlite@0.0.99
  - @workglow/storage@0.0.99
  - @workglow/task-graph@0.0.99
  - @workglow/tasks@0.0.99
  - @workglow/test@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/ai@0.0.98
  - @workglow/ai-provider@0.0.98
  - @workglow/debug@0.0.98
  - @workglow/job-queue@0.0.98
  - @workglow/sqlite@0.0.98
  - @workglow/storage@0.0.98
  - @workglow/task-graph@0.0.98
  - @workglow/tasks@0.0.98
  - @workglow/test@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/ai@0.0.97
  - @workglow/ai-provider@0.0.97
  - @workglow/debug@0.0.97
  - @workglow/job-queue@0.0.97
  - @workglow/sqlite@0.0.97
  - @workglow/storage@0.0.97
  - @workglow/task-graph@0.0.97
  - @workglow/tasks@0.0.97
  - @workglow/test@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/ai@0.0.96
  - @workglow/ai-provider@0.0.96
  - @workglow/debug@0.0.96
  - @workglow/job-queue@0.0.96
  - @workglow/sqlite@0.0.96
  - @workglow/storage@0.0.96
  - @workglow/task-graph@0.0.96
  - @workglow/tasks@0.0.96
  - @workglow/test@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/ai@0.0.95
  - @workglow/ai-provider@0.0.95
  - @workglow/debug@0.0.95
  - @workglow/job-queue@0.0.95
  - @workglow/sqlite@0.0.95
  - @workglow/storage@0.0.95
  - @workglow/task-graph@0.0.95
  - @workglow/tasks@0.0.95
  - @workglow/test@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/ai-provider@0.0.94
  - @workglow/task-graph@0.0.94
  - @workglow/job-queue@0.0.94
  - @workglow/storage@0.0.94
  - @workglow/sqlite@0.0.94
  - @workglow/debug@0.0.94
  - @workglow/tasks@0.0.94
  - @workglow/test@0.0.94
  - @workglow/util@0.0.94
  - @workglow/ai@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/ai-provider@0.0.93
  - @workglow/task-graph@0.0.93
  - @workglow/job-queue@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/sqlite@0.0.93
  - @workglow/debug@0.0.93
  - @workglow/tasks@0.0.93
  - @workglow/test@0.0.93
  - @workglow/util@0.0.93
  - @workglow/ai@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/ai-provider@0.0.92
  - @workglow/task-graph@0.0.92
  - @workglow/job-queue@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/sqlite@0.0.92
  - @workglow/debug@0.0.92
  - @workglow/tasks@0.0.92
  - @workglow/test@0.0.92
  - @workglow/util@0.0.92
  - @workglow/ai@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/ai-provider@0.0.91
  - @workglow/task-graph@0.0.91
  - @workglow/test@0.0.91
  - @workglow/util@0.0.91
  - @workglow/ai@0.0.91
  - @workglow/debug@0.0.91
  - @workglow/job-queue@0.0.91
  - @workglow/sqlite@0.0.91
  - @workglow/storage@0.0.91
  - @workglow/tasks@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/task-graph@0.0.90
  - @workglow/tasks@0.0.90
  - @workglow/test@0.0.90
  - @workglow/util@0.0.90
  - @workglow/ai@0.0.90
  - @workglow/ai-provider@0.0.90
  - @workglow/debug@0.0.90
  - @workglow/job-queue@0.0.90
  - @workglow/sqlite@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/test@0.0.89
  - @workglow/ai@0.0.89
  - @workglow/ai-provider@0.0.89
  - @workglow/debug@0.0.89
  - @workglow/job-queue@0.0.89
  - @workglow/sqlite@0.0.89
  - @workglow/storage@0.0.89
  - @workglow/task-graph@0.0.89
  - @workglow/tasks@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/ai-provider@0.0.88
  - @workglow/task-graph@0.0.88
  - @workglow/job-queue@0.0.88
  - @workglow/storage@0.0.88
  - @workglow/sqlite@0.0.88
  - @workglow/debug@0.0.88
  - @workglow/tasks@0.0.88
  - @workglow/test@0.0.88
  - @workglow/util@0.0.88
  - @workglow/ai@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/ai@0.0.87
  - @workglow/ai-provider@0.0.87
  - @workglow/debug@0.0.87
  - @workglow/job-queue@0.0.87
  - @workglow/sqlite@0.0.87
  - @workglow/storage@0.0.87
  - @workglow/task-graph@0.0.87
  - @workglow/tasks@0.0.87
  - @workglow/test@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/ai@0.0.86
  - @workglow/ai-provider@0.0.86
  - @workglow/debug@0.0.86
  - @workglow/job-queue@0.0.86
  - @workglow/sqlite@0.0.86
  - @workglow/storage@0.0.86
  - @workglow/task-graph@0.0.86
  - @workglow/tasks@0.0.86
  - @workglow/test@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/ai@0.0.85
  - @workglow/ai-provider@0.0.85
  - @workglow/debug@0.0.85
  - @workglow/job-queue@0.0.85
  - @workglow/sqlite@0.0.85
  - @workglow/storage@0.0.85
  - @workglow/task-graph@0.0.85
  - @workglow/tasks@0.0.85
  - @workglow/test@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/ai@0.0.84
  - @workglow/ai-provider@0.0.84
  - @workglow/debug@0.0.84
  - @workglow/job-queue@0.0.84
  - @workglow/sqlite@0.0.84
  - @workglow/storage@0.0.84
  - @workglow/task-graph@0.0.84
  - @workglow/tasks@0.0.84
  - @workglow/test@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/ai@0.0.83
  - @workglow/ai-provider@0.0.83
  - @workglow/debug@0.0.83
  - @workglow/job-queue@0.0.83
  - @workglow/sqlite@0.0.83
  - @workglow/storage@0.0.83
  - @workglow/task-graph@0.0.83
  - @workglow/tasks@0.0.83
  - @workglow/test@0.0.83
  - @workglow/util@0.0.83

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo
- Updated dependencies
  - @workglow/ai-provider@0.0.82
  - @workglow/task-graph@0.0.82
  - @workglow/job-queue@0.0.82
  - @workglow/storage@0.0.82
  - @workglow/sqlite@0.0.82
  - @workglow/debug@0.0.82
  - @workglow/tasks@0.0.82
  - @workglow/test@0.0.82
  - @workglow/util@0.0.82
  - @workglow/ai@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/task-graph@0.0.81
  - @workglow/job-queue@0.0.81
  - @workglow/storage@0.0.81
  - @workglow/sqlite@0.0.81
  - @workglow/debug@0.0.81
  - @workglow/test@0.0.81
  - @workglow/util@0.0.81
  - @workglow/ai@0.0.81
  - @workglow/ai-provider@0.0.81
  - @workglow/tasks@0.0.81

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes
- Updated dependencies
  - @workglow/ai@0.0.80
  - @workglow/ai-provider@0.0.80
  - @workglow/debug@0.0.80
  - @workglow/job-queue@0.0.80
  - @workglow/sqlite@0.0.80
  - @workglow/storage@0.0.80
  - @workglow/task-graph@0.0.80
  - @workglow/tasks@0.0.80
  - @workglow/test@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/tasks@0.0.79
  - @workglow/ai@0.0.79
  - @workglow/ai-provider@0.0.79
  - @workglow/debug@0.0.79
  - @workglow/job-queue@0.0.79
  - @workglow/sqlite@0.0.79
  - @workglow/storage@0.0.79
  - @workglow/task-graph@0.0.79
  - @workglow/test@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/ai@0.0.78
  - @workglow/ai-provider@0.0.78
  - @workglow/debug@0.0.78
  - @workglow/job-queue@0.0.78
  - @workglow/sqlite@0.0.78
  - @workglow/storage@0.0.78
  - @workglow/task-graph@0.0.78
  - @workglow/tasks@0.0.78
  - @workglow/test@0.0.78
  - @workglow/util@0.0.78

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes
- Updated dependencies
  - @workglow/ai-provider@0.0.77
  - @workglow/task-graph@0.0.77
  - @workglow/job-queue@0.0.77
  - @workglow/storage@0.0.77
  - @workglow/sqlite@0.0.77
  - @workglow/debug@0.0.77
  - @workglow/tasks@0.0.77
  - @workglow/test@0.0.77
  - @workglow/util@0.0.77
  - @workglow/ai@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/task-graph@0.0.76
  - @workglow/test@0.0.76
  - @workglow/ai@0.0.76
  - @workglow/ai-provider@0.0.76
  - @workglow/debug@0.0.76
  - @workglow/job-queue@0.0.76
  - @workglow/sqlite@0.0.76
  - @workglow/storage@0.0.76
  - @workglow/tasks@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/ai-provider@0.0.75
  - @workglow/task-graph@0.0.75
  - @workglow/job-queue@0.0.75
  - @workglow/storage@0.0.75
  - @workglow/sqlite@0.0.75
  - @workglow/debug@0.0.75
  - @workglow/tasks@0.0.75
  - @workglow/test@0.0.75
  - @workglow/util@0.0.75
  - @workglow/ai@0.0.75

## 0.0.74

### Patch Changes

- Another attempt at transferables
- Updated dependencies
  - @workglow/ai-provider@0.0.74
  - @workglow/task-graph@0.0.74
  - @workglow/job-queue@0.0.74
  - @workglow/storage@0.0.74
  - @workglow/sqlite@0.0.74
  - @workglow/debug@0.0.74
  - @workglow/tasks@0.0.74
  - @workglow/test@0.0.74
  - @workglow/util@0.0.74
  - @workglow/ai@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/ai@0.0.73
  - @workglow/ai-provider@0.0.73
  - @workglow/debug@0.0.73
  - @workglow/job-queue@0.0.73
  - @workglow/sqlite@0.0.73
  - @workglow/storage@0.0.73
  - @workglow/task-graph@0.0.73
  - @workglow/tasks@0.0.73
  - @workglow/test@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/ai-provider@0.0.72
  - @workglow/task-graph@0.0.72
  - @workglow/job-queue@0.0.72
  - @workglow/storage@0.0.72
  - @workglow/test@0.0.72
  - @workglow/util@0.0.72
  - @workglow/ai@0.0.72
  - @workglow/debug@0.0.72
  - @workglow/sqlite@0.0.72
  - @workglow/tasks@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/ai@0.0.71
  - @workglow/ai-provider@0.0.71
  - @workglow/debug@0.0.71
  - @workglow/job-queue@0.0.71
  - @workglow/sqlite@0.0.71
  - @workglow/storage@0.0.71
  - @workglow/task-graph@0.0.71
  - @workglow/tasks@0.0.71
  - @workglow/test@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/ai@0.0.70
  - @workglow/ai-provider@0.0.70
  - @workglow/debug@0.0.70
  - @workglow/job-queue@0.0.70
  - @workglow/sqlite@0.0.70
  - @workglow/storage@0.0.70
  - @workglow/task-graph@0.0.70
  - @workglow/tasks@0.0.70
  - @workglow/test@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/ai-provider@0.0.69
  - @workglow/ai@0.0.69
  - @workglow/debug@0.0.69
  - @workglow/job-queue@0.0.69
  - @workglow/sqlite@0.0.69
  - @workglow/storage@0.0.69
  - @workglow/task-graph@0.0.69
  - @workglow/tasks@0.0.69
  - @workglow/test@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/ai-provider@0.0.68
  - @workglow/ai@0.0.68
  - @workglow/debug@0.0.68
  - @workglow/job-queue@0.0.68
  - @workglow/sqlite@0.0.68
  - @workglow/storage@0.0.68
  - @workglow/task-graph@0.0.68
  - @workglow/tasks@0.0.68
  - @workglow/test@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/ai-provider@0.0.67
  - @workglow/tasks@0.0.67
  - @workglow/test@0.0.67
  - @workglow/ai@0.0.67
  - @workglow/debug@0.0.67
  - @workglow/job-queue@0.0.67
  - @workglow/sqlite@0.0.67
  - @workglow/storage@0.0.67
  - @workglow/task-graph@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/ai@0.0.66
  - @workglow/ai-provider@0.0.66
  - @workglow/debug@0.0.66
  - @workglow/job-queue@0.0.66
  - @workglow/sqlite@0.0.66
  - @workglow/storage@0.0.66
  - @workglow/task-graph@0.0.66
  - @workglow/tasks@0.0.66
  - @workglow/test@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/ai@0.0.65
  - @workglow/ai-provider@0.0.65
  - @workglow/debug@0.0.65
  - @workglow/job-queue@0.0.65
  - @workglow/sqlite@0.0.65
  - @workglow/storage@0.0.65
  - @workglow/task-graph@0.0.65
  - @workglow/tasks@0.0.65
  - @workglow/test@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/ai@0.0.64
  - @workglow/ai-provider@0.0.64
  - @workglow/debug@0.0.64
  - @workglow/job-queue@0.0.64
  - @workglow/sqlite@0.0.64
  - @workglow/storage@0.0.64
  - @workglow/task-graph@0.0.64
  - @workglow/tasks@0.0.64
  - @workglow/test@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/ai@0.0.63
  - @workglow/ai-provider@0.0.63
  - @workglow/debug@0.0.63
  - @workglow/job-queue@0.0.63
  - @workglow/sqlite@0.0.63
  - @workglow/storage@0.0.63
  - @workglow/task-graph@0.0.63
  - @workglow/tasks@0.0.63
  - @workglow/test@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/ai@0.0.62
  - @workglow/ai-provider@0.0.62
  - @workglow/debug@0.0.62
  - @workglow/job-queue@0.0.62
  - @workglow/sqlite@0.0.62
  - @workglow/storage@0.0.62
  - @workglow/task-graph@0.0.62
  - @workglow/tasks@0.0.62
  - @workglow/test@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/ai@0.0.61
  - @workglow/ai-provider@0.0.61
  - @workglow/debug@0.0.61
  - @workglow/job-queue@0.0.61
  - @workglow/sqlite@0.0.61
  - @workglow/storage@0.0.61
  - @workglow/task-graph@0.0.61
  - @workglow/tasks@0.0.61
  - @workglow/test@0.0.61
  - @workglow/util@0.0.61

## 0.0.60

### Patch Changes

- Rework and simplify the model repo
- Updated dependencies
  - @workglow/ai-provider@0.0.60
  - @workglow/task-graph@0.0.60
  - @workglow/job-queue@0.0.60
  - @workglow/storage@0.0.60
  - @workglow/sqlite@0.0.60
  - @workglow/debug@0.0.60
  - @workglow/tasks@0.0.60
  - @workglow/test@0.0.60
  - @workglow/util@0.0.60
  - @workglow/ai@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/ai-provider@0.0.59
  - @workglow/storage@0.0.59
  - @workglow/test@0.0.59
  - @workglow/util@0.0.59
  - @workglow/ai@0.0.59
  - @workglow/debug@0.0.59
  - @workglow/job-queue@0.0.59
  - @workglow/sqlite@0.0.59
  - @workglow/task-graph@0.0.59
  - @workglow/tasks@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/ai-provider@0.0.58
  - @workglow/task-graph@0.0.58
  - @workglow/job-queue@0.0.58
  - @workglow/storage@0.0.58
  - @workglow/test@0.0.58
  - @workglow/ai@0.0.58
  - @workglow/debug@0.0.58
  - @workglow/sqlite@0.0.58
  - @workglow/tasks@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/ai@0.0.57
  - @workglow/ai-provider@0.0.57
  - @workglow/debug@0.0.57
  - @workglow/job-queue@0.0.57
  - @workglow/sqlite@0.0.57
  - @workglow/storage@0.0.57
  - @workglow/task-graph@0.0.57
  - @workglow/tasks@0.0.57
  - @workglow/test@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/task-graph@0.0.56
  - @workglow/util@0.0.56
  - @workglow/ai@0.0.56
  - @workglow/ai-provider@0.0.56
  - @workglow/debug@0.0.56
  - @workglow/job-queue@0.0.56
  - @workglow/sqlite@0.0.56
  - @workglow/storage@0.0.56
  - @workglow/tasks@0.0.56
  - @workglow/test@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/sqlite@0.0.55
  - @workglow/test@0.0.55
  - @workglow/ai@0.0.55
  - @workglow/ai-provider@0.0.55
  - @workglow/debug@0.0.55
  - @workglow/job-queue@0.0.55
  - @workglow/storage@0.0.55
  - @workglow/task-graph@0.0.55
  - @workglow/tasks@0.0.55
  - @workglow/util@0.0.55

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask
- Updated dependencies
  - @workglow/ai-provider@0.0.54
  - @workglow/task-graph@0.0.54
  - @workglow/job-queue@0.0.54
  - @workglow/storage@0.0.54
  - @workglow/sqlite@0.0.54
  - @workglow/debug@0.0.54
  - @workglow/tasks@0.0.54
  - @workglow/test@0.0.54
  - @workglow/util@0.0.54
  - @workglow/ai@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/tasks@0.0.53
  - @workglow/test@0.0.53
  - @workglow/ai@0.0.53
  - @workglow/ai-provider@0.0.53
  - @workglow/debug@0.0.53
  - @workglow/job-queue@0.0.53
  - @workglow/sqlite@0.0.53
  - @workglow/storage@0.0.53
  - @workglow/task-graph@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/ai-provider@0.0.52
  - @workglow/task-graph@0.0.52
  - @workglow/job-queue@0.0.52
  - @workglow/storage@0.0.52
  - @workglow/sqlite@0.0.52
  - @workglow/debug@0.0.52
  - @workglow/tasks@0.0.52
  - @workglow/test@0.0.52
  - @workglow/util@0.0.52
  - @workglow/ai@0.0.52
