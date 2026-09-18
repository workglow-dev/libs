# @workglow/cli

## 0.6.6

_No changes in this package._

## 0.6.5

_No changes in this package._

## 0.6.4

_No changes in this package._

## 0.6.3

### Features

- add @huggingface/transformers-structured-output dependency and update related packages

#### cli

- implement process signal abort handling in CLI commands and UI components

### Bug Fixes

- update stripAnsi function to handle control characters and enhance date parsing in publishedDate module

#### ai

- stop a graph JSON document turning off an agent's tool approvals

## 0.6.2

### Features

#### cli,util

- let a person refuse a form, not only submit or abandon it

### Bug Fixes

#### cli

- honour a refusal on the form-load-error panel

## 0.6.1

### Features

- serve a saved agent over A2A from the CLI

#### cli,workglow

- serve headless, refuse a model-less agent, and share the serve helpers

### Bug Fixes

#### util

- move humanPromptModel where a browser can reach it

## 0.6.0

### Breaking Changes

- **bug fixes(mcp)**: require the auth choice startMcpHttpServer serves under (#933)

### Features

#### ai

- AgentTask: the tool-calling turn loop as a task, with the CLI and its console on it (#935)

### Bug Fixes

#### mcp

- require the auth choice startMcpHttpServer serves under (#933)

## 0.5.1

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

- route human-in-the-loop tasks to the MCP client
- serve registered tasks over MCP, behind a bearer token

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

#### cli

- mark what an `all` command actually runs, and give a command group its own page in the web console

### Bug Fixes

- close the gaps a review of the MCP server turned up
- file the human-in-the-loop tasks under "Human", not "Flow Control"

#### util

- repair the Node worker path and drop the Bun worker fork

#### pricing

- various fixes for pricing on models
- merge a declared rate card over the provider's field by field
- resolve rates from the live table and at the request's instant

#### cli/web

- share one status-rail read instead of tearing down under it

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

### Features

#### pricing

- refactor model pricing resolution and enhance test coverage
- enhance model pricing structure and update cost estimation logic

#### cli

- add consoleRoot function and corresponding tests, fixing web ui
- add registerWebStatusReadCleanup for managing widget cleanup after status reads

### Style

- enhance cli web ui app.css layout and responsiveness

## 0.4.7

### Features

- enhance command tree and UI layout for nested items, filter out web when running web

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

### CI

- run ESLint in CI, behind a cached turbo task

## 0.4.4

### Bug Fixes

#### tasks

- make dropping the filesystem tasks a compile-time decision

#### cli

- stop the answer reader from closing the parent's descriptor

## 0.4.3

### Bug Fixes

- react hook dep

### Build

- types

## 0.4.2

## 0.4.1

### Features

- implement stacked pane navigation in CLI web client

#### cli

- export the command-tree and field helpers a downstream verifies with
- annotation seams and richer contributed UI for the web console

### Bug Fixes

#### cli

- address review — scope churn, dialog name, and a mid-pattern `**`

### Tests

#### cli

- pin that re-registering an annotation replaces rather than appends

## 0.4.0

## 0.3.49

### Features

#### web

- gate the console on a 1s heartbeat to the CLI

#### cli

- reach the grid rendering, and stop offering a flag that is not there
- extension seams for the console, plus docs and a packaging guard
- the web console's client
- serve the console — run registry, routes, and the `web` command
- read the command surface and its form off the live program
- let a parent process ask a run for a machine-readable stream
- make the run footer a status bar
- give run rows the trailing column, elapsed, and failure reason

### Bug Fixes

#### web

- survive an IPv6 host, a dead child, and an unreadable asset

#### cli

- stop the answers reader from pinning a finished child alive
- a finished graph is not a finished run
- report what a task owns, not just the top-level graph
- install run reporting in the seam, not in one CLI's boot
- show the output of a command that builds no task graph
- scope a run to the command that started it, and show the theme choice
- offer task config, and keep a run's shape in the buffer
- read run answers from their own descriptor, not stdin

### Refactors

#### cli

- extract the pure run-row model out of the Ink components

### Documentation

- reshoot the CLI screenshot and add the web console

### Chores

#### cli

- add documentation images and update README references

## 0.3.48

## 0.3.47

## 0.3.46

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

### Features

#### cli

- add tests for live iteration graphs in WorkflowRunApp

### Bug Fixes

#### task-graph

- reject own() config for an already-constructed task

### Refactors

#### tests

- replace pipe with addTask in workflow tests

### Chores

- format changes

## 0.3.39

### Features

- add tests for task usage duration and enhance usage line handling
- implement CLI duration formatting and enhance task usage tracking

#### cli-example

- show live input and output token counts

### Bug Fixes

- usage tracking for owned subtasks in Task Graph

#### cli-example

- render token usage on the actual rendered path

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

### Refactors

#### pricing

- optimize model pricing state management and improve usage line updates

#### cli-example

- hoist the footer's format call and drop a needless cast

### Tests

- run tests through Turbo and per-package vitest projects

#### cli-example

- gate usage emission on a mounted row, not a fixed sleep

### Chores

- update deps
- update CodeMirror dependencies and improve TypeScript configuration
- upgrade to catalog for many deps and update the deps themselves

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

### Updated Dependencies

- `commander`: catalog:
- `react`: catalog:
- `smol-toml`: ^1.8.0
- `@types/react`: catalog:

## 0.3.38

## 0.3.37

### Bug Fixes

- data-URI decode order, own() tracking for functions, UI wiring
- bound CLI listener retention, reject double-own, decode binary data URIs

### Refactors

#### cli

- type the status listener and tighten removal assertions

### Tests

- cover wrapper removal that bypasses disown

## 0.3.36

## 0.3.35

### Features

#### task-graph

- add context.disown so owners can release finished subtasks

## 0.3.34

### Features

#### cli

- show the work inside an owned workflow, not just its wrapper row
- label task rows by instance title, not class type

### Bug Fixes

#### cli

- pass label, not type, on the iteration row

## 0.3.33

### Features

- add subtask rows rendering and management for task execution

#### deepseek

- add DeepSeek AI provider

### Tests

- add unit tests for registerIterationListeners functionality

## 0.3.32

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.18

## 0.3.30

## 0.3.29

### Chores

- update deps

### Updated Dependencies

- `chalk`: ^6.0.0
- `smol-toml`: ^1.7.1

## 0.3.28

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `ink`: ^7.1.1
- `react`: ^19.2.8

## 0.3.26

### Features

- add Workglow Eval: CLI harness for model evaluation on HuggingFace datasets (#636)

## 0.3.25

### Features

#### providers

- add xAI (Grok) AI provider(#622)

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Bug Fixes

#### google-gemini

- migrate to @google/genai; fix thinking-model tool calls and structured output (#620)

## 0.3.23

## 0.3.22

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

### Updated Dependencies

- `smol-toml`: ^1.7.0

## 0.3.16

### Chores

- update deps

### Updated Dependencies

- `ink`: ^7.1.0

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

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.17

## 0.3.11

### Bug Fixes

#### storage,ai

- SQL operator allow-list + baseURL validation + credential-store passphrase sentinel (#546)

## 0.3.10

### Chores

- update deps

### Updated Dependencies

- `commander`: ^15.0.0
- `ink`: ^7.0.5
- `react`: ^19.2.7
- `@types/react`: ^19.2.16

## 0.3.9

### Chores

- update deps

### Updated Dependencies

- `ink`: ^7.0.4

## 0.3.8

## 0.3.7

## 0.3.6

### Refactors

#### cli

- replace execSync with spawnSync for editor command execution and add command parsing functionality

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

### Chores

- update deps

### Updated Dependencies

- `@types/react`: ^19.2.15

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

## 0.2.36

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
- fixup some wrong links after rename

#### dependencies

- update package versions and lockfile, and remove bun tests from CI

### CI

- empty commit to retrigger main Build & Test

### Updated Dependencies

- `ink`: ^7.0.3

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

### Chores

- update deps

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

### Updated Dependencies

- `react`: ^19.2.6

## 0.2.31

### Updated Dependencies

- `ink`: ^7.0.2

## 0.2.30

## 0.2.29

## 0.2.28

### Bug Fixes

- examples imports for moved symbols

### Refactors

#### mcp

- move MCP tasks and util from @workglow/tasks to @workglow/mcp

#### browser-control

- move browser-control backends from @workglow/tasks to @workglow/browser-control

#### ai-provider

- final trim of vendor subpaths and SDK peers

#### node-llama-cpp

- move provider from @workglow/ai-provider to @workglow/node-llama-cpp

#### huggingface-inference

- move provider from @workglow/ai-provider to @workglow/huggingface-inference

#### huggingface-transformers

- move provider from @workglow/ai-provider to @workglow/huggingface-transformers

## 0.2.27

## 0.2.26

## 0.2.25

## 0.2.24

## 0.2.23

## 0.2.22

### Chores

- update deps

### Updated Dependencies

- `@napi-rs/keyring`: ^1.3.0

## 0.2.21

### Features

#### examples

- render indeterminate progress and phase labels

#### task-graph

- indeterminate progress and StreamPhase events

#### ai

- image generation pipeline with ImageValue boundary

## 0.2.20

## 0.2.19

## 0.2.18

## 0.2.17

## 0.2.16

### Features

#### task-graph

- dataflow transforms engine with autoConnect refactor

### Chores

- release 12 packages

## 0.2.15

### Features

#### task-graph

- dataflow transforms engine with autoConnect refactor

## 0.2.14

### Bug Fixes

#### cli

- improve terminal theme detection and stdin handling

## 0.2.13

## 0.2.12

## 0.2.11

### Refactors

#### tests

- streamline Chrome availability checks and add tests

## 0.2.10

## 0.2.9

### Features

#### cli

- run AiChatTask from a workflow; per-task row rendering

### Refactors

#### cli

- update output handling for task and workflow commands

## 0.2.8

### Chores

- update deps

### Updated Dependencies

- `ink`: ^7.0.1

## 0.2.7

### Features

#### browser-control

- add browser automation framework with multiple backends

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

### Bug Fixes

#### cli

- update run function to accept additional runConfig parameter

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### cli

- update ink to v7 and adopt new hooks (#372)
- keyring (#367)

#### knowledge-base

- implement shared-table mode for knowledge bases

### Chores

- release 12 packages
- format changes

### Updated Dependencies

- `ink`: ^7.0.0
- `react`: ^19.2.5

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### cli

- update ink to v7 and adopt new hooks (#372)
- keyring (#367)

#### knowledge-base

- implement shared-table mode for knowledge bases

### Chores

- format changes

### Updated Dependencies

- `ink`: ^7.0.0
- `react`: ^19.2.5

## 0.1.2

## 0.1.1

## 0.1.0

### Features

- wire up OAuth2/credential support for MCP tasks in CLI (#328)

#### storage

- update McpServerRecordSchema to include auth_type and refactor createMcpStorage function

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

### Refactors

- update McpServerRecordSchema and improve credential handling

### Chores

#### dependencies

- update package versions for improved compatibility

## 0.0.126

## 0.0.125

### Features

#### cli

- enhance CLI integration with task and workflow commands

### Chores

#### dependencies

- update various package versions for improved stability and features

### Updated Dependencies

- `smol-toml`: ^1.6.1

## 0.0.124

## 0.0.123

### Features

#### cli

- add interactive task and workflow execution with enhanced rendering

#### ai-provider

- integrate js-tiktoken for OpenAI token counting in browser

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Features

- enhance CLI with MCP support and input handling
- rebuild CLI with resource-oriented command structure

#### cli

- add edit commands for agents, MCP servers, models, and workflows
- implement CLI task UI components and subscription handling
- implement JSON parsing utility for input handling
- add model cache directory configuration for HFT worker
- enhance model command with ONNX dtype parsing and task mapping
- add detail commands for agent, MCP, model, task, and workflow
- implement nested object value manipulation functions
- print Cancelled message on Escape for all TUI components
- show confirmation line after select/search selection
- adaptive list sizing and scroll indicators
- Escape cancels any TUI form
- model find now asks for provider first with per-provider search
- interactive select for remove commands when no id given
- add model find command with HuggingFace search
- add mcp find command with MCP registry search
- add renderSearchSelect helper in render.ts
- add SearchSelectApp component for live-search TUI

#### mcp

- move implemention of MCP search functionality into new McpSearchTask and integrate with CLI

### Bug Fixes

- return worker for hft

#### cli

- clear TUI output before unmounting Ink instances
- fix SearchSelectApp loading-more spinner and remove unused pageSize prop

### Refactors

- split the sdk off to worker only
- reorg ai-provider a bit more
- ai provider

#### mcp

- enhance MCP search functionality with pagination support

### Chores

- add @typescript/native-preview package and make updates for tsgo
- rename tests to represent storage

#### cli

- update ink and react versions, and adjust model command imports

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

### Bug Fixes

- update ONNX model configurations to use q8 quantization when on cpu as f16 not supported
- update ONNX model ID and dtype across multiple files

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.110

## 0.0.109

## 0.0.108

## 0.0.107

### Bug Fixes

- enhance HuggingFace Transformers provider with streaming and reactive tasks support

## 0.0.106

### Features

- add tool-calling command to CLI for sending prompts with tool definitionsl; improved toolcall
- improve ui of cli; default cli to worker

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/ai@0.0.105
  - @workglow/ai-provider@0.0.105
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
  - @workglow/task-graph@0.0.104
  - @workglow/tasks@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/ai@0.0.103
  - @workglow/ai-provider@0.0.103
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
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/ai@0.0.100
  - @workglow/ai-provider@0.0.100
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
  - @workglow/storage@0.0.94
  - @workglow/tasks@0.0.94
  - @workglow/util@0.0.94
  - @workglow/ai@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/ai-provider@0.0.93
  - @workglow/task-graph@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/tasks@0.0.93
  - @workglow/util@0.0.93
  - @workglow/ai@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/ai-provider@0.0.92
  - @workglow/task-graph@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/tasks@0.0.92
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
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/test@0.0.89
  - @workglow/ai@0.0.89
  - @workglow/ai-provider@0.0.89
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
  - @workglow/storage@0.0.88
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
  - @workglow/storage@0.0.82
  - @workglow/tasks@0.0.82
  - @workglow/test@0.0.82
  - @workglow/util@0.0.82
  - @workglow/ai@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/task-graph@0.0.81
  - @workglow/storage@0.0.81
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
  - @workglow/storage@0.0.77
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
  - @workglow/storage@0.0.76
  - @workglow/tasks@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/ai-provider@0.0.75
  - @workglow/task-graph@0.0.75
  - @workglow/storage@0.0.75
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
  - @workglow/storage@0.0.74
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
  - @workglow/storage@0.0.72
  - @workglow/test@0.0.72
  - @workglow/util@0.0.72
  - @workglow/ai@0.0.72
  - @workglow/tasks@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/ai@0.0.71
  - @workglow/ai-provider@0.0.71
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
  - @workglow/storage@0.0.67
  - @workglow/task-graph@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/ai@0.0.66
  - @workglow/ai-provider@0.0.66
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
  - @workglow/storage@0.0.60
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
  - @workglow/task-graph@0.0.59
  - @workglow/tasks@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/ai-provider@0.0.58
  - @workglow/task-graph@0.0.58
  - @workglow/storage@0.0.58
  - @workglow/test@0.0.58
  - @workglow/ai@0.0.58
  - @workglow/tasks@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/ai@0.0.57
  - @workglow/ai-provider@0.0.57
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
  - @workglow/storage@0.0.56
  - @workglow/tasks@0.0.56
  - @workglow/test@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/test@0.0.55
  - @workglow/ai@0.0.55
  - @workglow/ai-provider@0.0.55
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
  - @workglow/storage@0.0.54
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
  - @workglow/storage@0.0.53
  - @workglow/task-graph@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/ai-provider@0.0.52
  - @workglow/task-graph@0.0.52
  - @workglow/storage@0.0.52
  - @workglow/tasks@0.0.52
  - @workglow/test@0.0.52
  - @workglow/util@0.0.52
  - @workglow/ai@0.0.52
