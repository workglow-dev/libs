# @workglow/tasks

## 0.6.1

_No changes in this package._

## 0.6.0

_No changes in this package._

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

### Bug Fixes

- file the human-in-the-loop tasks under "Human", not "Flow Control"

### Chores

- revert version change not made by bunset

## 0.4.9

### Chores

- update dependencies

### Updated Dependencies

- `undici`: ^8.10.2

## 0.4.8

### Bug Fixes

- handle Retry-After: 0 and negative values correctly (#888)

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

### Features

#### task

- implement entitlement enforcement in TaskRunner and TaskGraphRunner

### Bug Fixes

#### tasks

- make dropping the filesystem tasks a compile-time decision

### Updated Dependencies

- `undici`: ^8.10.1

## 0.4.3

### Chores

- update deps

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

### Breaking Changes

- **bug fixes(tasks)**: declare the owned FetchUrlTask entitlements on FileLoaderTask

### Bug Fixes

#### tasks

- bound sedLines with a search deadline and restore the node export surface
- accept optional groups in the regex screen and bound RegexTask matching
- declare the owned FetchUrlTask entitlements on FileLoaderTask

## 0.3.48

### Breaking Changes

- **bug fixes(tasks)**: contain the server filesystem tasks by default

### Features

#### tasks

- improve error body reading in FetchUrlTask
- enhance FetchUrlJobError to include detailed HTTP error messages

### Bug Fixes

#### tasks

- reject method HEAD paired with response_type text/json/blob/arraybuffer
- bound the error body read instead of buffering all of it
- contain the server filesystem tasks by default
- keep $<name> literal when the pattern has no named groups
- emit each grep context line once instead of replaying it

## 0.3.47

### Features

#### tasks

- enhance FileGrepTask with extractBatch functionality
- add support for HEAD HTTP method in FetchUrlTask
- add onlyMatching to FileGrepTask
- add FileGrepTask for server-side file grepping

### Bug Fixes

#### tasks

- apply default output caps to FileSedTask
- cap FileSedTask line length instead of accumulating unterminated lines
- name the configured root that cannot be resolved
- declare the owned FetchUrlTask entitlements on FileSedTask
- declare filesystem:read and resolve FileSedTask paths against roots
- bound FileSedTask regex substitution with an interruptible budget
- reconcile the ReDoS guard with the base branch's scanner
- declare the fileGrep Workflow augmentation with one config type
- apply default output caps and report match/truncated honestly
- cap FileGrepTask line length instead of accumulating unterminated lines
- declare the owned FetchUrlTask entitlements on FileGrepTask
- declare filesystem:read and resolve FileGrepTask paths against opt-in roots
- bound FileGrepTask regex matching with an interruptible time budget
- make the ReDoS guard linear, and add FileSedTask

### Refactors

#### tasks

- share the streaming line splitter between file tasks
- share the regex ReDoS guard between RegexTask and FileGrepTask

### Performance

#### tasks

- make FileGrepTask group de-duplication O(1) per line

### Documentation

#### tasks

- correct FileGrepTask url documentation for http(s) vs filesystem

### Build

- fix build

## 0.3.46

### Bug Fixes

#### tasks

- stop replaying method and body across SafeFetch redirects
- fail a queued "stream" fetch whose deltas never arrived

## 0.3.45

### Breaking Changes

- **features(tasks)**: drop the response_type default
- **features(tasks)**: FetchUrlTask gains a body stream port, response_type required

### Features

#### tasks

- re-emit an out-of-process worker's CacheRef as deltas
- stream the queued fetch over the job channel
- drop the response_type default
- 304 is a successful outcome carrying notModified
- stream the fetch body, verify Content-Length
- FetchUrlTask gains a body stream port, response_type required

### Bug Fixes

#### tasks

- fail a queued fetch carrying no response_type
- refuse a conditional request only where a row could be written
- report a queued fetch's falsy rejection as the failure it is
- release the body of a response the fetch never reads
- copy the fetch chunk the carrier is free to transfer away
- stop measuring a decoded body against its encoded Content-Length
- refuse response_type "stream" on a carrier that cannot stream
- refuse an undeclared private resolution from a domain-key fetch
- refuse a conditional request against every cache the run has
- stop replaying credentials to cross-origin redirect targets
- end the queued fetch's drain on the stream's own terminal event
- make the queued fetch's subclass seam and retry rule safe
- drop invalid override on FetchUrlTask.executeStream
- route queued FetchUrlTask runs through execute() from executeStream

### Refactors

#### tasks

- drop the speculative CacheRef byte source from the queued fetch
- pin response_type at every call site

### Documentation

#### tasks

- correct three claims the fetch's own code contradicts
- correct three overclaims in the queued fetch's stream contract

## Unreleased

### Breaking Changes

- **feat(tasks)**: `FetchUrlTask` / `FetchUrlJob` require `response_type`, and no longer infer it

  `response_type` was optional and, when absent, the response format was guessed from the
  `Content-Type` header. Both are gone: the input schema now lists `response_type` in
  `required`, it declares no default, and there is no Content-Type inference left — so a
  caller that stated nothing no longer gets whichever format the sniffing would have picked.

  Two caveats on how loudly that lands. A directly constructed `FetchUrlTask` still runs
  without one: `Task`'s constructor seeds its defaults from the input schema and synthesizes
  an `enum` property as its first member, which here is `"stream"`. A **persisted job
  payload** with no `response_type` now fails with `INVALID_RESPONSE_TYPE` before the request
  is issued, where it previously streamed and completed successfully with no value.

  Migration — state what the consumer actually reads:

  - `"stream"` reproduces the previous byte-level behaviour exactly. The bytes still reach
    the `body` port and the output cache, `metadata.contentType` reports what they are, and
    nothing is buffered into memory.
  - `"json"`, `"text"`, `"blob"`, `"arraybuffer"` additionally populate the matching derived
    port, replacing whatever the Content-Type sniffing used to pick.

  Re-enqueue any job enqueued before this change with an explicit `response_type`.

### Features

#### tasks

- `FetchUrlTask` streams its response body to the output cache instead of buffering it.
  The `body` output port is a binary stream port, so a downstream streaming consumer reads
  bytes as they arrive; the task accumulates only when something actually needs the whole
  value (a derived `response_type`, or a cache that cannot take a stream). A fetch whose
  bytes nobody materializes no longer holds the response in memory.
- `FetchUrlTask` supports conditional requests. Send `If-None-Match` / `If-Modified-Since`
  and a 304 returns `metadata.notModified` with no body, no derived port and no cache write,
  so the caller keeps the artifact it already had.

### Security

#### tasks

- stop replaying credentials to cross-origin redirect targets in `safeFetch`.
  Both redirect loops (`SafeFetch.ts` and `SafeFetch.server.ts`) now drop
  `authorization`, `proxy-authorization`, and `cookie` on any hop whose target
  origin differs from the current one — origin comparison, so a differing scheme
  or port also counts. `SafeFetchOptions.sensitiveHeaders` names additional
  headers to drop, which `FetchUrlTask` supplies for
  `credential_scheme: "header"` (the secret sits on a caller-named header such
  as `X-Api-Key` that `safeFetch` cannot otherwise recognize). Once a header is
  stripped it stays stripped for the remainder of the chain, so a
  `vendor -> attacker -> vendor` redirect cannot launder it back.

### Bug Fixes

#### tasks

- stop asserting `Content-Length` against a transparently decompressed body. `Content-Length`
  states the ENCODED size while the read loop counts DECODED bytes, so every gzip/br response
  failed `CONTENT_LENGTH_MISMATCH` — a permanent, non-retryable error raised after the correct
  body had already reached the consumer and the cache sink. A response carrying a
  content-coding now reports no progress and asserts no total, exactly like a chunked one.
- release the response body on a non-2xx fetch. The server transport holds an undici `Agent`
  (and its socket) open until the passthrough pipe carrying the body settles, and an
  unread `TransformStream` readable never lets it; an HTTP error abandoned the body without
  cancelling, leaking an Agent per attempt — ten per job on the queued path's `maxAttempts`.
- fail a queued fetch whose persisted payload carries no `response_type` instead of streaming
  and returning an output with no value. `JobQueueWorker` runs a persisted input with no schema
  validation, so the task layer's `required` never sees it; the job now asserts it before
  issuing the request.
- copy a retained body chunk rather than aliasing the view handed to the stream transport, which
  `Job`'s contract lets the carrier transfer (and so detach). Only runs that materialize a
  derived port pay the copy.

## 0.3.44

## 0.3.43

## 0.3.42

### Bug Fixes

#### tasks

- stop a response body deciding whether a fetch decode failure retries

### Chores

- update deps

## 0.3.41

### Features

#### task

- add network error handling for fetch URL tasks

### Chores

- update deps

## 0.3.40

## 0.3.39

### Bug Fixes

#### tasks

- handle the SafeFetch body-pipe rejection instead of crashing the process
- keep resolved credentials out of queued job payloads, add credential schemes (#677)

#### test

- close the gaps the Turbo/projects wiring opened

### Chores

- update deps

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

### Updated Dependencies

- `ipaddr.js`: ^2.5.0
- `undici`: ^8.10.0

## 0.3.38

## 0.3.37

### Features

#### dataUri

- implement dataUriToBlob function for decoding data URIs to Blobs

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

### Chores

- update deps

### Updated Dependencies

- `undici`: ^8.9.0

## 0.3.28

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `undici`: ^8.8.0

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Bug Fixes

#### tasks

- route SafeFetch.server redirect ceiling through SECURITY_LIMITS

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Updated Dependencies

- `undici`: ^8.7.0

## 0.3.23

### Bug Fixes

#### tasks

- route SafeFetch.server redirect ceiling through SECURITY_LIMITS

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Chores

- update deps
- format / lint

### Updated Dependencies

- `undici`: ^8.7.0

## 0.3.22

### Chores

- update deps

### Updated Dependencies

- `undici`: ^8.6.0

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

### Chores

- update deps

### Updated Dependencies

- `undici`: ^8.5.0

## 0.3.15

### Bug Fixes

- eslint fixes

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

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

### Chores

- format

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### ai

- update image input handling across vision tasks

#### job-queue

- enhance error handling with machine-readable codes

### Bug Fixes

- FetchUrl permanent codes + SQLite v4 + error-code registry (#518)

### Refactors

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

## 0.2.36

### Chores

- update deps

### Updated Dependencies

- `undici`: ^8.3.0

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

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

## 0.2.30

## 0.2.29

### Chores

- update deps

### Updated Dependencies

- `ipaddr.js`: ^2.4.0

## 0.2.28

### Refactors

#### tasks

- strip MCP and browser-control auto-registration from runtime entries

#### mcp

- move MCP tasks and util from @workglow/tasks to @workglow/mcp

#### browser-control

- move browser-control backends from @workglow/tasks to @workglow/browser-control

#### javascript

- move JavaScriptTask + interpreter from @workglow/tasks to @workglow/javascript

## 0.2.27

## 0.2.26

## 0.2.25

### Refactors

#### task-graph

- migrate per-run state from facade fields to TaskRunContext

### Chores

- update deps

### Updated Dependencies

- `undici`: ^8.2.0

## 0.2.24

## 0.2.23

## 0.2.22

## 0.2.21

### Features

#### ai

- image generation pipeline with ImageValue boundary

## 0.2.20

## 0.2.19

## 0.2.18

### Features

#### tasks/image

- ImageTextTask.executePreview applies preview-scale to fontSize/dims
- scalePreviewParams hook + 5 filter overrides; fallback preserves previewScale
- add CSS rgb/rgba color schema and validation
- task-layer CPU fallback when backend filter arm is missing
- per-mode lifecycle in ImageFilterTask; resourceScope output disposer

#### util/media, tasks/image

- real WGSL shaders for 16 image filters
- refcount-based GpuImage lifecycle; eliminate releaseSource

#### util/media, tasks

- previewSource downscales WebGPU images at the chain head

#### util/media, tasks/image, ai, task-graph

- GpuImage pipeline (Phases 1-8)

### Bug Fixes

#### tasks/image

- hydrateInput handles ImageBinary, Blob, ImageBitmap, and data: URIs

### Refactors

#### tasks/image

- consolidate image filter operations and update imports
- remove ImageWatermarkTask

#### util/media, tasks/image

- colocate WGSL per filter; apply.shader is raw string

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

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

#### task-graph

- dataflow transforms engine with autoConnect refactor

### Chores

- release 12 packages

## 0.2.15

### Features

#### util/media

- introduce Image class and consolidate image handling

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

#### task-graph

- dataflow transforms engine with autoConnect refactor

## 0.2.14

### Bug Fixes

#### cli

- improve terminal theme detection and stdin handling

## 0.2.13

## 0.2.12

### Refactors

#### task-graph

- introduce isPassthrough flag for task types

## 0.2.11

## 0.2.10

## 0.2.9

### Features

#### ai

- AiChatTask, canonical ChatMessage, and worker streaming

### Refactors

#### task-graph

- clean up imports and improve formatting

## 0.2.8

## 0.2.7

### Features

#### browser-control

- add browser automation framework with multiple backends

#### tasks

- add ImageTextTask for rendering text onto images

### Updated Dependencies

- `undici`: ^8.1.0

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

### Bug Fixes

#### tasks

- re-validate SSRF redirect targets against network:private grant scope (#407)

### Chores

- format

## 0.2.4

### Updated Dependencies

- `undici`: ^8.0.2

## 0.2.3

### Features

- add SSRF protection to FetchUrlTask with dynamic entitlements (#405)

### Bug Fixes

- add image codec security limits and validation helpers (#404)

### Chores

- format

## 0.2.2

### Features

#### tasks

- enhance image processing capabilities (#402)

### Refactors

#### FetchUrlTask

- enhance private URL handling

## 0.2.1

### Features

#### tasks

- add image processing task library (#395)

### Chores

- formatting

## 0.2.0

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### mcp

- replace boolean flag with promise to prevent TOCTOU race in… (#390)
- enhance type safety for input and output schemas in McpToolCallTask

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### tests

- update ScopedStorage tests for type safety

### Chores

- release 12 packages

## 0.1.3

### Features

- add pkg-pr-new for preview package publishing (#379)
- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### mcp

- replace boolean flag with promise to prevent TOCTOU race in… (#390)
- enhance type safety for input and output schemas in McpToolCallTask

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### tests

- update ScopedStorage tests for type safety

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Features

#### queue-status

- remove JobQueueTask from the task class heirarchy

### Bug Fixes

#### tasks

- security hardening, bug fixes, and robustness improvements (#337)

### Refactors

- update McpServerRecordSchema and improve credential handling

#### tasks

- consolidate MCP client utilities and add registry resolution for them to configs

### Chores

- update TypeScript and package dependencies

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

## 0.0.125

## 0.0.124

### Refactors

#### task

- enhance input handling with Partial types
- clean up input handling and improve parameter naming

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

#### cli

- implement CLI task UI components and subscription handling

#### mcp

- move implemention of MCP search functionality into new McpSearchTask and integrate with CLI

### Refactors

- update package exports to use source files instead of dist

#### util

- reorganize MCP-related and toolcalling related code

#### mcp

- enhance MCP search functionality with pagination support

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)
- introduce AgentTask for multi-turn agentic loops

### Refactors

- update MCP task schemas to use properties and allOf from mcpServerConfigSchema

### Chores

- release 14 packages
- update tsconfig to avoid node_modules

## 0.0.118

### Features

- add chrome web browser provider (#303)
- introduce AgentTask for multi-turn agentic loops

### Refactors

- update MCP task schemas to use properties and allOf from mcpServerConfigSchema

### Chores

- update tsconfig to avoid node_modules

## 0.0.117

### Features

- introduce AgentTask for multi-turn agentic loops

### Chores

- update tsconfig to avoid node_modules

## 0.0.116

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.111

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

## 0.0.109

## 0.0.108

## 0.0.107

## 0.0.106

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/job-queue@0.0.105
  - @workglow/storage@0.0.105
  - @workglow/task-graph@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/job-queue@0.0.104
  - @workglow/task-graph@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/job-queue@0.0.103
  - @workglow/storage@0.0.103
  - @workglow/task-graph@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/job-queue@0.0.102
  - @workglow/storage@0.0.102
  - @workglow/task-graph@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/task-graph@0.0.101
  - @workglow/job-queue@0.0.101
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/job-queue@0.0.100
  - @workglow/storage@0.0.100
  - @workglow/task-graph@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/job-queue@0.0.99
  - @workglow/storage@0.0.99
  - @workglow/task-graph@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/job-queue@0.0.98
  - @workglow/storage@0.0.98
  - @workglow/task-graph@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/job-queue@0.0.97
  - @workglow/storage@0.0.97
  - @workglow/task-graph@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/job-queue@0.0.96
  - @workglow/storage@0.0.96
  - @workglow/task-graph@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
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
  - @workglow/storage@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/task-graph@0.0.93
  - @workglow/job-queue@0.0.93
  - @workglow/storage@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/task-graph@0.0.92
  - @workglow/job-queue@0.0.92
  - @workglow/storage@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/task-graph@0.0.91
  - @workglow/util@0.0.91
  - @workglow/job-queue@0.0.91
  - @workglow/storage@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/task-graph@0.0.90
  - @workglow/util@0.0.90
  - @workglow/job-queue@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
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
  - @workglow/storage@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/job-queue@0.0.87
  - @workglow/storage@0.0.87
  - @workglow/task-graph@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
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
