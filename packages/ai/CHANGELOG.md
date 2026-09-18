# @workglow/ai

## 0.6.6

### Features

- implement withoutToolExecutors function to strip execute methods from tools

### Chores

- format

## 0.6.5

### Features

- add image input and cached tokens to usage tracking

## 0.6.4

_No changes in this package._

## 0.6.3

### Bug Fixes

#### ai

- stop a graph JSON document turning off an agent's tool approvals

## 0.6.2

_No changes in this package._

## 0.6.1

### Features

#### job-queue,util,ai

- carry a failure's retryability across the worker boundary

## 0.6.0

### Features

#### task-graph,ai

- a tool call's whole life on the wire (#936)

#### ai

- AgentTask: the tool-calling turn loop as a task, with the CLI and its console on it (#935)

### Bug Fixes

#### pricing

- stop reporting an unpriced rate as free (#930)

## 0.5.1

### Features

- chat agent utilities (#929)

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

#### task-graph

- add entitlement approval gate for ai task classes (#923)

### Bug Fixes

#### pricing

- various fixes for pricing on models
- merge a declared rate card over the provider's field by field
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

### Refactors

#### pricing

- simplify pricing property in ModelConfigSchema to turn down type budget

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

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

### Bug Fixes

#### ai

- drop readonly from effort_options on ModelConfig/ModelRecord
- report the tokens a fully-failed structured generation billed

## 0.3.41

### Features

#### ai

- add AiProvider.effortPolicy hook
- add ModelEffortPolicy and effort_options helpers

## 0.3.40

### Bug Fixes

#### ai

- refuse to settle an estimated usage snapshot in the accumulator (#754)

### Performance

#### ai

- stream tool-call argument JSON instead of re-parsing the buffer

## 0.3.39

### Features

- enhance provisional usage reporting in AI provider streams
- implement CLI duration formatting and enhance task usage tracking

#### ai

- add ModelConfig.effort coarse thinking dial
- add a shared usage and cost formatter
- charge checkpoint cache storage at disposal
- add estimateCost over disjoint usage buckets
- add optional per-model pricing to the model schema
- fold usage snapshots in the accumulator and publish from AiTask
- add a ./test entry and drop _testOnly from the public API

#### providers

- emit cumulative usage snapshots mid-stream

### Bug Fixes

- improve usage tracking
- make the ./test entries survive a real build

#### ai,task-graph

- keep heuristic usage estimates out of accounting

#### task-graph,ai

- route a checkpoint's storage charge into the run total

#### ai

- delete the CheckpointEntry fields nothing reads
- attribute chat spend to the chat model
- charge every checkpoint's storage cost, not just the last link
- count the whole prompt in the usage arrow
- keep checkpoint teardown from stranding registry entries
- require explicit ModelPricing rates and make the type assertion enforceable
- make the OpenAI-shaped usage mappers report disjoint input

#### task-graph

- detach the run's usage listeners at run end

#### test

- close the gaps the Turbo/projects wiring opened

### Tests

- run tests through Turbo and per-package vitest projects
- move 174 more unit tests into their owning packages

#### ai

- verify OpenAI cache counters are portions of input_tokens
- drop the unused binding without gutting the pricing check
- pin the cumulative detail level and the detailed cached counter
- drop the non-falsifiable ModelPricing round-trip

### Chores

- add Lezer dependencies and update Vite configuration

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

### Features

#### ai

- add a uniform usage telemetry channel

### Bug Fixes

#### task-graph

- correctness fixes from branch-wide streaming review

#### ai

- record usage telemetry for the multi-turn chat tasks
- sum every chat turn's usage onto the outer finish
- record usage telemetry when a stream consumer stops early
- record usage telemetry on the streaming path too

## 0.3.37

### Features

#### dataUri

- implement dataUriToBlob function for decoding data URIs to Blobs

## 0.3.36

## 0.3.35

## 0.3.34

### Refactors

- update maxTokens description and implement reasoning allowances

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

### Bug Fixes

#### ai

- stop AiTask.narrowInput from mutating its input argument

#### openai

- surface silent Responses-API regressions from 0.3.26 (H2)

## 0.3.26

### Bug Fixes

#### ai

- key OpenAIShapedResponses tool-call accumulator on stable item id

#### xai,openrouter

- guard chunk.choices access and downshift strict schema

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

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

## 0.3.23

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Chores

- format / lint

## 0.3.22

### Bug Fixes

#### ai

- make StreamEventAccumulator delta-wins to stop tool-call clobber
- unify capability gating, implement real RRF, document retry behavior
- correct provider lifecycle, dispatch, and task bugs found in review

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

### Bug Fixes

- codeql fix for regex
- eslint fixes

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add typecheck budget guard to catch type-instantiation regressions (#555)
- add bugs URL to package.json files across all packages and providers

### Bug Fixes

#### ai

- export ChunkRetrievalInputSchema + nightly schema-vs-type drift guard (#565)

## 0.3.13

## 0.3.12

### Bug Fixes

#### ai

- align IPv6 loopback check with isLoopbackHostname
- label-boundary match on provider base-URL host allow-list

### Chores

- comment review pass across packages and providers

## 0.3.11

### Bug Fixes

#### storage,ai

- SQL operator allow-list + baseURL validation + credential-store passphrase sentinel (#546)

## 0.3.10

### Bug Fixes

#### ai

- close WHATWG canonicalisation bypass in localOnlyFetch (sec) (#542)

## 0.3.9

### Chores

- update deps

## 0.3.8

### Features

- add provider runtime metadata: supportsServer and isAvailable() (#538)

### Bug Fixes

- close redirect-based SSRF bypass in local provider fetches (sec) (#536)

## 0.3.7

### Bug Fixes

#### ai,llamacpp-server,stable-diffusion-server

- strict local-only URL allow-list (sec) (#533)

## 0.3.6

### Features

#### ai

- IBackendsTransport interface + provider package scaffolding

## 0.3.5

### Features

#### ai

- enhance AiTask with model property requirements and semantic validation

#### chrome-ai

- enhance WebBrowser provider with new capabilities and session management

### Bug Fixes

- Chrome-ai (#514)

## 0.3.4

## 0.3.3

## 0.3.2

### Features

- add Cactus (needle-rs) local tool-calling provider (#524)

### Refactors

- remove pre-v1 backward-compat code paths (#523)

## 0.3.1

## 0.3.0

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

#### task-graph

- policy-driven cache layer with durable execution

### Bug Fixes

- update web example

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### ai

- update image input handling across vision tasks
- enhance HuggingFace model configuration and pipeline mapping

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

### Features

#### kb

- pluggable strategy with model config, IRunConfig threading, and document tasks

### Bug Fixes

#### util/worker, ai/task

- TTL-based pendingAborts eviction; clarify runWithIterable bond (#500)

#### ai

- avoid NaN reranker scores for empty queries
- escape regex metacharacters in RerankerTask.simpleRerank
- classify provider-error vs no-finish in AiTask.execute
- replace runWithIterable Proxy with shallow clone

## 0.2.35

### Features

#### ai/task

- runWithIterable helper that propagates consumer abort

#### ai,util/worker

- Promise+emit run-fn shape foundation

#### ai,test,ci

- bridgeProgress utility and large-model integration test harness

#### ai

- introduce capability-based dispatch (Phases 0-4)
- enhance AiChatWithKbTask and HierarchicalChunkerTask with section handling and slugification
- chat task responseFormat input — markdown addendum, inline citation, URL-aware chunks
- KbSearchTask + AiChatWithKbTask + AiChatTask cleanup

#### ai,task-graph

- thread runConfig through CreateWorkflow and AI wrappers (#490)

#### knowledge-base

- hybrid search via RRF over BM25F text index (#478)

### Bug Fixes

#### test,ai

- align AiChatWithKbTask disposer test with model.dispose lookup

#### ai/chat-kb

- route per-turn dispatch through runWithIterable

#### ai/chat

- route per-turn dispatch through runWithIterable

#### ai/task

- propagate consumer abort through StreamingAiTask via runWithIterable

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

#### ai,providers,test

- Phase 5 review feedback and CI/test fixes

#### ai

- emit iterations on finish + composite kb:doc key + clarify text schema

### Refactors

- remove loadProviderSdk utility and streamline SDK loading in client implementations

#### ai

- rename local unloadFn to disposeFn in AiTask.execute
- finalize Promise+emit migration and cleanup
- migrate execution path to Promise+emit shape

#### providers

- migrate all providers to AiProviderRunFnRegistration[] (Phase 5)

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Tests

#### ai,timing

- align fixtures and add memory tooling for Promise+emit

### Chores

- release 30 packages
- release 30 packages
- fixup some wrong links after rename

#### ai

- add organize-imports-ignore to ai barrels after rebase on main
- export runWithIterable from the task barrel for tests / external use

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

## 0.2.34

### Bug Fixes

#### ai

- emit iterations on finish + composite kb:doc key + clarify text schema

## 0.2.33

### Features

#### ai

- enhance AiChatWithKbTask and HierarchicalChunkerTask with section handling and slugification
- chat task responseFormat input — markdown addendum, inline citation, URL-aware chunks
- KbSearchTask + AiChatWithKbTask + AiChatTask cleanup

### Refactors

- remove loadProviderSdk utility and streamline SDK loading in client implementations

### Chores

- fixup some wrong links after rename

## 0.2.32

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

### Chores

- format

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Refactors

#### ai

- update task categories from "Vector Store" to "Document"

### Chores

- update docs to reflect current code

## 0.2.29

## 0.2.28

### Refactors

- update libs imports for queue/limiter symbols moved to @workglow/job-queue

## 0.2.27

### Bug Fixes

#### job-queue

- release by token to fix wrong-row deletion under contention

### Refactors

#### job-queue

- atomic claim+limit, LISTEN/NOTIFY, and same-process hot-path

## 0.2.26

## 0.2.25

### Tests

- quick fix

## 0.2.24

## 0.2.23

### Features

#### model-search

- add credential_key support for model searches

## 0.2.22

## 0.2.21

### Features

#### ai

- introduce TypeLandmark schema and update related tasks
- default phase emission and per-subclass phase labels
- image generation pipeline with ImageValue boundary

#### task-graph

- indeterminate progress and StreamPhase events

## 0.2.20

## 0.2.19

## 0.2.18

### Features

#### util/media, tasks/image, ai, task-graph

- GpuImage pipeline (Phases 1-8)

### Refactors

#### task-graph, util/media

- unify refcountable predicate registration and enhance image handling

## 0.2.17

### Features

#### task-graph,tasks

- split run() from runPreview() and add execute() to concrete tasks

### Bug Fixes

- address code-reviewer feedback

### Refactors

#### util,ai

- rename worker reactive APIs to preview for consistency

#### libs

- rename executeReactive -> executePreview

### Chores

- format changes

## 0.2.16

### Features

#### util/media

- introduce Image class and consolidate image handling

### Bug Fixes

- add validation for outputSchema in StructuredGenerationTask, changes to tool use schema

### Refactors

#### ai

- simplify and consolidate RAG tasks (#427)

### Chores

- release 12 packages

## 0.2.15

### Features

#### util/media

- introduce Image class and consolidate image handling

### Bug Fixes

- add validation for outputSchema in StructuredGenerationTask, changes to tool use schema

## 0.2.14

### Tests

#### streaming

- detect reorder, fix abort race, correct cancel docs

### Documentation

#### streaming

- formalize primitive contract, cancel semantics, add stress tests

## 0.2.13

## 0.2.12

### Refactors

#### task-graph

- introduce isPassthrough flag for task types

## 0.2.11

## 0.2.10

## 0.2.9

### Features

#### kb

- stable public API for vector search and lifecycle hooks

#### ai

- StructuredGenerationTask validates output and retries on mismatch
- AiChatTask, canonical ChatMessage, and worker streaming

## 0.2.8

### Features

#### ai

- session caching for multi-turn AI tasks

## 0.2.7

### Features

#### util

- add ResourceScope for heavyweight resource lifecycle management

#### ai

- add KbToDocumentsTask and relax vector dimension check
- add model dimensions detail to ModelInfo system

### Refactors

#### ai-provider

- consolidate tool parsers, remove FunctionGemma, and add shared provider utilities

### Chores

- format

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

### Features

#### ai

- DocumentUpsertTask accepts optional metadata input

### Documentation

#### ai

- note additive metadata input on DocumentUpsertTask
- explain required: [] override on DocumentUpsertTask metadata port

## Unreleased

### Features

#### tasks

- DocumentUpsertTask now accepts an optional `metadata` input that mirrors the open
  `DocumentMetadataSchema`. Callers can pass full frontmatter (`sourceUri`, `createdAt`,
  `author`, `tags`, custom fields) instead of being limited to `title`. The `title`
  input remains optional and takes precedence over `metadata.title` when both are
  present, so existing callers need no changes.

## 0.2.4

## 0.2.3

### Features

#### tasks

- add DocumentUpsertTask for document persistence

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

### Bug Fixes

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

### Chores

- release 12 packages

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

### Bug Fixes

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

#### ai

- standardize timeout handling for local models

## 0.1.0

### Features

#### ai-provider

- enhance AI provider tests with new thinking model and tool updates
- enhance timeout handling and function calling local model support

#### queue-status

- remove JobQueueTask from the task class heirarchy

#### docs

- update model configurations to use structured object format

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

### Refactors

- remove array input support from most AI provider implementations (#333)

#### ai

- remove ToolCallingTask and related utilities
- decouple AI execution from job queue with strategy pattern

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### ai

- refine model search output schema with specific model type
- enhance model search functionality with query filtering

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

## 0.0.124

### Features

#### ai-provider

- add displayName property to AiProvider and its implementations

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
- more moving around to make workers smaller (95% smaller now)
- split the sdk off to worker only
- ai provider

#### ai-provider

- introduce queued providers for various AI models

#### util

- reorganize MCP-related and toolcalling related code

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)
- enhance AgentTask and content block handling enabling multimedia
- introduce AgentTask for multi-turn agentic loops

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- improve type imports and message handling in AgentTask and tests

### Refactors

- unify tool call handling across providers
- enhance tool handling and message conversion

### Chores

- release 14 packages
- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.118

### Features

- add chrome web browser provider (#303)
- enhance AgentTask and content block handling enabling multimedia
- introduce AgentTask for multi-turn agentic loops

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- improve type imports and message handling in AgentTask and tests

### Refactors

- unify tool call handling across providers
- enhance tool handling and message conversion

### Chores

- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.117

### Features

- enhance AgentTask and content block handling enabling multimedia
- introduce AgentTask for multi-turn agentic loops

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- improve type imports and message handling in AgentTask and tests

### Refactors

- unify tool call handling across providers
- enhance tool handling and message conversion

### Chores

- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update VSCode settings and refactor task categories

## 0.0.116

### Refactors

- clean up code formatting and imports across multiple files
- streamline task configuration and code generation in GraphToWorkflowCode
- update type imports and SDK loading in AI provider modules

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.112

## 0.0.111

## 0.0.110

### Features

- add build-js and watch-js scripts across packages
- add detail property to ModelInfoTask and enhance HFT_ModelInfo processing

### Bug Fixes

- ensure type safety for input and output schemas across AI tasks

## 0.0.109

### Features

- introduce ModelInfoTask and enhance AiProvider with local and browser support properties

## 0.0.108

## 0.0.107

### Bug Fixes

- enhance HuggingFace Transformers provider with streaming and reactive tasks support

## 0.0.106

### Features

- add tool-calling command to CLI for sending prompts with tool definitionsl; improved toolcall

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/dataset@0.0.105
  - @workglow/job-queue@0.0.105
  - @workglow/storage@0.0.105
  - @workglow/task-graph@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/dataset@0.0.104
  - @workglow/job-queue@0.0.104
  - @workglow/task-graph@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/dataset@0.0.103
  - @workglow/job-queue@0.0.103
  - @workglow/storage@0.0.103
  - @workglow/task-graph@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/dataset@0.0.102
  - @workglow/job-queue@0.0.102
  - @workglow/storage@0.0.102
  - @workglow/task-graph@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/task-graph@0.0.101
  - @workglow/dataset@0.0.101
  - @workglow/job-queue@0.0.101
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/dataset@0.0.100
  - @workglow/job-queue@0.0.100
  - @workglow/storage@0.0.100
  - @workglow/task-graph@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/dataset@0.0.99
  - @workglow/job-queue@0.0.99
  - @workglow/storage@0.0.99
  - @workglow/task-graph@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/dataset@0.0.98
  - @workglow/job-queue@0.0.98
  - @workglow/storage@0.0.98
  - @workglow/task-graph@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/dataset@0.0.97
  - @workglow/job-queue@0.0.97
  - @workglow/storage@0.0.97
  - @workglow/task-graph@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/dataset@0.0.96
  - @workglow/job-queue@0.0.96
  - @workglow/storage@0.0.96
  - @workglow/task-graph@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/dataset@0.0.95
  - @workglow/job-queue@0.0.95
  - @workglow/storage@0.0.95
  - @workglow/task-graph@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/task-graph@0.0.94
  - @workglow/job-queue@0.0.94
  - @workglow/dataset@0.0.94
  - @workglow/storage@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/task-graph@0.0.93
  - @workglow/job-queue@0.0.93
  - @workglow/dataset@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/task-graph@0.0.92
  - @workglow/job-queue@0.0.92
  - @workglow/dataset@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/task-graph@0.0.91
  - @workglow/util@0.0.91
  - @workglow/dataset@0.0.91
  - @workglow/job-queue@0.0.91
  - @workglow/storage@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/task-graph@0.0.90
  - @workglow/util@0.0.90
  - @workglow/dataset@0.0.90
  - @workglow/job-queue@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/dataset@0.0.89
  - @workglow/job-queue@0.0.89
  - @workglow/storage@0.0.89
  - @workglow/task-graph@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/task-graph@0.0.88
  - @workglow/job-queue@0.0.88
  - @workglow/dataset@0.0.88
  - @workglow/storage@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/dataset@0.0.87
  - @workglow/job-queue@0.0.87
  - @workglow/storage@0.0.87
  - @workglow/task-graph@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/dataset@0.0.86
  - @workglow/job-queue@0.0.86
  - @workglow/storage@0.0.86
  - @workglow/task-graph@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/job-queue@0.0.85
  - @workglow/storage@0.0.85
  - @workglow/task-graph@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/job-queue@0.0.84
  - @workglow/storage@0.0.84
  - @workglow/task-graph@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/job-queue@0.0.83
  - @workglow/storage@0.0.83
  - @workglow/task-graph@0.0.83
  - @workglow/util@0.0.83

## 0.0.82

### Patch Changes

- Small updates for model definitions and repo
- Updated dependencies
  - @workglow/task-graph@0.0.82
  - @workglow/job-queue@0.0.82
  - @workglow/storage@0.0.82
  - @workglow/util@0.0.82

## 0.0.81

### Patch Changes

- Fix mediapipe download for vision models
- Updated dependencies
  - @workglow/task-graph@0.0.81
  - @workglow/job-queue@0.0.81
  - @workglow/storage@0.0.81
  - @workglow/util@0.0.81

## 0.0.80

### Patch Changes

- Renamed FetchTask to FetchUrlTask, and camelCased the workflow methods, all breaking changes
- Updated dependencies
  - @workglow/job-queue@0.0.80
  - @workglow/storage@0.0.80
  - @workglow/task-graph@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/job-queue@0.0.79
  - @workglow/storage@0.0.79
  - @workglow/task-graph@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/job-queue@0.0.78
  - @workglow/storage@0.0.78
  - @workglow/task-graph@0.0.78
  - @workglow/util@0.0.78

## 0.0.77

### Patch Changes

- semantic compat via format should allow dashes
- Updated dependencies
  - @workglow/task-graph@0.0.77
  - @workglow/job-queue@0.0.77
  - @workglow/storage@0.0.77
  - @workglow/util@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/task-graph@0.0.76
  - @workglow/job-queue@0.0.76
  - @workglow/storage@0.0.76
  - @workglow/util@0.0.76

## 0.0.75

### Patch Changes

- Change priority order for image transfer across workers
- Updated dependencies
  - @workglow/task-graph@0.0.75
  - @workglow/job-queue@0.0.75
  - @workglow/storage@0.0.75
  - @workglow/util@0.0.75

## 0.0.74

### Patch Changes

- Another attempt at transferables
- Updated dependencies
  - @workglow/task-graph@0.0.74
  - @workglow/job-queue@0.0.74
  - @workglow/storage@0.0.74
  - @workglow/util@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/job-queue@0.0.73
  - @workglow/storage@0.0.73
  - @workglow/task-graph@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/task-graph@0.0.72
  - @workglow/job-queue@0.0.72
  - @workglow/storage@0.0.72
  - @workglow/util@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/job-queue@0.0.71
  - @workglow/storage@0.0.71
  - @workglow/task-graph@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/job-queue@0.0.70
  - @workglow/storage@0.0.70
  - @workglow/task-graph@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/job-queue@0.0.69
  - @workglow/storage@0.0.69
  - @workglow/task-graph@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/job-queue@0.0.68
  - @workglow/storage@0.0.68
  - @workglow/task-graph@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/job-queue@0.0.67
  - @workglow/storage@0.0.67
  - @workglow/task-graph@0.0.67
  - @workglow/util@0.0.67

## 0.0.66

### Patch Changes

- Subscriptions for all tabular repositories
- Updated dependencies
  - @workglow/job-queue@0.0.66
  - @workglow/storage@0.0.66
  - @workglow/task-graph@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/job-queue@0.0.65
  - @workglow/storage@0.0.65
  - @workglow/task-graph@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/job-queue@0.0.64
  - @workglow/storage@0.0.64
  - @workglow/task-graph@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/job-queue@0.0.63
  - @workglow/storage@0.0.63
  - @workglow/task-graph@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/job-queue@0.0.62
  - @workglow/storage@0.0.62
  - @workglow/task-graph@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/job-queue@0.0.61
  - @workglow/storage@0.0.61
  - @workglow/task-graph@0.0.61
  - @workglow/util@0.0.61

## 0.0.60

### Patch Changes

- Rework and simplify the model repo
- Updated dependencies
  - @workglow/task-graph@0.0.60
  - @workglow/job-queue@0.0.60
  - @workglow/storage@0.0.60
  - @workglow/util@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/storage@0.0.59
  - @workglow/util@0.0.59
  - @workglow/job-queue@0.0.59
  - @workglow/task-graph@0.0.59

## 0.0.58

### Patch Changes

- Refactored the lame job queue into a less lame job queue
- Updated dependencies
  - @workglow/task-graph@0.0.58
  - @workglow/job-queue@0.0.58
  - @workglow/storage@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/job-queue@0.0.57
  - @workglow/storage@0.0.57
  - @workglow/task-graph@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/task-graph@0.0.56
  - @workglow/util@0.0.56
  - @workglow/job-queue@0.0.56
  - @workglow/storage@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/job-queue@0.0.55
  - @workglow/storage@0.0.55
  - @workglow/task-graph@0.0.55
  - @workglow/util@0.0.55

## 0.0.54

### Patch Changes

- Update output shcema on input changes for FetchTask
- Updated dependencies
  - @workglow/task-graph@0.0.54
  - @workglow/job-queue@0.0.54
  - @workglow/storage@0.0.54
  - @workglow/util@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/job-queue@0.0.53
  - @workglow/storage@0.0.53
  - @workglow/task-graph@0.0.53
  - @workglow/util@0.0.53

## 0.0.52

### Patch Changes

- First release under "workglow" naming
- Updated dependencies
  - @workglow/task-graph@0.0.52
  - @workglow/job-queue@0.0.52
  - @workglow/storage@0.0.52
  - @workglow/util@0.0.52
