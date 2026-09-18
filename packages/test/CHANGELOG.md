# @workglow/test

## 0.6.6

### Features

- add HFT model file size guard and related error handling

### Chores

- format

## 0.6.5

### Features

- add image input and cached tokens to usage tracking

## 0.6.4

### Features

- enhance FetchUrlTask and FileLoaderTask to support array of URLs for entitlements.

## 0.6.3

### Features

- add @huggingface/transformers-structured-output dependency and update related packages

### Bug Fixes

#### chrome-ai

- carry the tool exchange into the next tool-calling round

#### ai

- stop a graph JSON document turning off an agent's tool approvals

### Refactors

#### vscode

- update settings for formatting and linting

### Updated Dependencies

- `miniflare`: ^5.20260916.0-alpha

## 0.6.2

### Features

#### cli,util

- let a person refuse a form, not only submit or abandon it

## 0.6.1

### Features

#### test-contract

- publish the conformance suites so downstream adapters can inherit them

#### job-queue,util,ai

- carry a failure's retryability across the worker boundary

### Bug Fixes

#### test

- fill vi.waitFor in Bun's vitest shim, so the nightly is green

#### scripts

- gate the release on green CI before anything writes or pushes

### Tests

#### test-contract

- close four gaps a review found in the new suites

#### web-search

- hold all seven providers to the capability record they publish

#### storage

- hold the two join strategies to the same answer

### Chores

- update deps

### Updated Dependencies

- `miniflare`: ^5.20260915.0-alpha

## 0.6.0

### Features

#### task-graph,ai

- a tool call's whole life on the wire (#936)

#### ai

- AgentTask: the tool-calling turn loop as a task, with the CLI and its console on it (#935)

### Bug Fixes

#### storage

- decide the join pushdown on enlistment, not the instance flag (#934)

#### pricing

- stop reporting an unpriced rate as free (#930)

### Updated Dependencies

- `miniflare`: ^5.20260911.0-alpha

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

#### util

- repair the Node worker path and drop the Bun worker fork

#### postgres

- give a vector storage a real pgvector column

#### release

- gate publish-all on tests again (#916)

#### pricing

- various fixes for pricing on models
- resolve rates from the live table and at the request's instant

#### storage

- stop connection transactions hanging and leaking uncommitted rows
- guard updateWhere's primary key on the transaction path

### Refactors

#### storage

- route the tx handle through the public methods

### Tests

#### pricing

- assert the billing unit in the contract suite, off the same fixtures

### Chores

- revert version change not made by bunset
- update bunset and its configuration and dependencies

### Updated Dependencies

- `miniflare`: ^5.20260908.0-alpha

## 0.4.9

### Features

#### storage

- add the not-in search operator

### Bug Fixes

#### storage

- an undefined criterion matches nothing, on every backend
- restore the deleteSearch guard on the transaction path
- align `in` with SQL on nulls, refuse a table-wide deleteSearch

#### test

- drop a @ts-expect-error Vitest 5 made unused

### Chores

- update dependencies

### Updated Dependencies

- `miniflare`: ^5.20260903.0-alpha

## 0.4.8

### Features

#### pricing

- refactor model pricing resolution and enhance test coverage
- enhance model pricing structure and update cost estimation logic

#### tests

- add HFT fetch stall watchdog tests

### Bug Fixes

- handle Retry-After: 0 and negative values correctly (#888)

#### sqlite

- similaritySearch decoded an already-decoded vector (#889)

## 0.4.7

### Bug Fixes

#### storage

- queue concurrent transactions whose participants differ
- queue unrelated concurrent callers on the connection mutex

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Features

- add withConnectionTransaction for sibling storages on one handle. (#842)
- migrate SQLite driver from better-sqlite3 to node:sqlite (#710)

### Chores

- update deps
- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

### Updated Dependencies

- `miniflare`: ^5.20260831.0-alpha

## 0.4.5

### Bug Fixes

#### ai

- make the effort policies a gate rather than UI metadata

#### node-llama-cpp

- stop embedding GGUFs advertising chat-session capabilities

## 0.4.4

### Features

#### interpreter

- enhance TypeScript definitions for interpreter functionality

#### task

- implement entitlement enforcement in TaskRunner and TaskGraphRunner

#### tf-mediapipe

- add Face Detector model and enhance TensorFlow MediaPipe search tests

#### image

- introduce toTexImageSource utility and integrate across AI components

### Bug Fixes

#### tasks

- make dropping the filesystem tasks a compile-time decision

### Refactors

- FsFolderTabularStorage for improved file handling and error management

### Updated Dependencies

- `miniflare`: ^5.20260828.0-alpha

## 0.4.1

### Bug Fixes

- address PR review feedback for cactus v2 paths

### Refactors

- enhance Cactus model loading and tool calling functionality

### Chores

- fix tests
- update deps

### Updated Dependencies

- `miniflare`: ^5.20260820.0-alpha

## 0.4.0

### Bug Fixes

#### tests

- remove process listeners through the EventEmitter view

## 0.3.49

### Breaking Changes

- **bug fixes(tasks)**: declare the owned FetchUrlTask entitlements on FileLoaderTask

### Bug Fixes

#### test

- detect DeepSeek billing failures, and split credit skips CI vs local

#### tasks

- bound sedLines with a search deadline and restore the node export surface
- accept optional groups in the regex screen and bound RegexTask matching
- declare the owned FetchUrlTask entitlements on FileLoaderTask

## 0.3.48

### Breaking Changes

- **bug fixes(tasks)**: contain the server filesystem tasks by default

### Features

#### tasks

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

- thinking policy for models

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
- apply default output caps and report match/truncated honestly
- cap FileGrepTask line length instead of accumulating unterminated lines
- declare the owned FetchUrlTask entitlements on FileGrepTask
- declare filesystem:read and resolve FileGrepTask paths against opt-in roots
- bound FileGrepTask regex matching with an interruptible time budget
- make the ReDoS guard linear, and add FileSedTask

### Refactors

#### tasks

- share the regex ReDoS guard between RegexTask and FileGrepTask

### Performance

#### tasks

- make FileGrepTask group de-duplication O(1) per line

### Tests

#### tasks

- pin the escaped-bracket case the class-stripping regex missed

### Chores

- update deps

### Updated Dependencies

- `miniflare`: ^5.20260815.0-alpha

## 0.3.46

### Features

#### schema

- enhance JSON schema handling for strict compatibility

#### tests

- add tests for compound-key chunking behavior in PostgresTabularStorage
- add credit exhaustion handling and skip logic for provider tests

#### triggers

- add the triggers package with cron, interval, and polling triggers

#### storage

- enforce varchar width and NOT NULL in InMemoryTabularStorage

### Bug Fixes

#### ai

- stop reporting nullable-object schemas as OpenAI strict-compatible

#### tasks

- stop replaying method and body across SafeFetch redirects
- fail a queued "stream" fetch whose deltas never arrived

## 0.3.45

### Breaking Changes

- **features(tasks)**: FetchUrlTask gains a body stream port, response_type required
- **bug fixes(task-graph)**: stop clearRun dangling blob refs; restore the publish test gate (#793)
- **refactors(task-graph)**: always return a Promise from getOutputStreamByRef

### Features

#### tasks

- re-emit an out-of-process worker's CacheRef as deltas
- stream the queued fetch over the job channel
- 304 is a successful outcome carrying notModified
- stream the fetch body, verify Content-Length
- FetchUrlTask gains a body stream port, response_type required

#### task-graph

- stream N binary output ports to cache on the unflagged path

### Bug Fixes

#### task-graph

- re-resolve credential inputs on a re-run instead of blanking them (#799)
- stop clearRun dangling blob refs; restore the publish test gate (#793)

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

### Refactors

#### task-graph

- always return a Promise from getOutputStreamByRef

#### tasks

- drop the speculative CacheRef byte source from the queued fetch
- pin response_type at every call site

### Performance

#### task-graph

- delete a run's private cache rows by name, not by scanning

### Tests

#### tasks

- say what the terminal-marker test actually pins
- cover FetchUrlTask's queued executeStream delegation

## 0.3.44

### Bug Fixes

#### task-graph

- stop caching ConditionalTask and cover unfed branch ports
- derive branch ports for conditionConfig-driven ConditionalTask

## 0.3.43

### Breaking Changes

- **refactors(task-graph)**: collapse the dual streaming writer surfaces

### Refactors

#### task-graph

- collapse the dual streaming writer surfaces

## 0.3.42

### Bug Fixes

#### tasks

- stop a response body deciding whether a fetch decode failure retries

#### hft

- choose the background-removal encoder by runtime, not by method existence

## 0.3.41

### Features

#### task

- add network error handling for fetch URL tasks

#### xai

- map model.effort and stamp Grok listing policies

#### ai-providers

- stamp effort_options from class policies

#### openai

- report effort policy and stamp listing records

### Bug Fixes

#### task-graph

- drop the owned-sink stamp on disown

### Chores

- update deps

### Updated Dependencies

- `miniflare`: ^5.20260811.1-alpha

## 0.3.40

### Features

#### cli

- add tests for live iteration graphs in WorkflowRunApp

### Bug Fixes

#### test

- add the six missing provider references to packages/test tsconfig

#### hft

- encode background-removal output without RawImage.toBase64

#### task-graph

- reject own() config for an already-constructed task

### Performance

#### ai

- stream tool-call argument JSON instead of re-parsing the buffer

## 0.3.39

### Features

- enhance model existence verification in AI provider streams
- enhance provisional usage reporting in AI provider streams
- dd prefill phase emission to HFT streaming

#### models

- update pricing and add new model for DeepSeek

#### anthropic

- honor model.effort for extended/adaptive thinking

#### deepseek

- map model.effort to reasoning_allowance

#### openrouter

- map model.effort into reasoning extras

#### openai

- map model.effort to Responses reasoning

#### hft

- report local token counts as usage, not a phase message

#### gemini

- report checkpoint write tokens and cache lifetime
- add support for reproducible generation with sampling seed

#### providers

- report cache-checkpoint warm-up token cost
- emit cumulative usage snapshots mid-stream

#### storage

- enhance query operators to support null handling and inequality checks

#### task-graph

- ship InMemoryTaskOutputRepository from ./test

#### ai

- add a ./test entry and drop _testOnly from the public API

#### util

- add a ./test entry and drop _testOnly from the public API

### Bug Fixes

- improve usage tracking
- usage tracking for owned subtasks in Task Graph
- reunite the graph test helper with its dependents
- make the ./test entries survive a real build

#### huggingface-inference

- forward provider-stated usage from text run-fns
- encode Hub model ids per path segment

#### anthropic

- keep an in-range top_p under legacy extended thinking
- build a legal request under legacy extended thinking

#### ai,task-graph

- keep heuristic usage estimates out of accounting

#### task-graph

- count an owned child's late charge once
- scope usage sinks to the run that supplied them
- count a nested task's spend once, not once per hop
- break the Task/ConditionalTask module cycle
- key usage buckets without string collision

#### gemini

- remove structured-generation 2048 thinking default
- return cache disposal result through the queued path
- report disjoint input and fold thoughts into output

#### tasks

- handle the SafeFetch body-pipe rejection instead of crashing the process
- keep resolved credentials out of queued job payloads, add credential schemes (#677)

#### task-graph,ai

- route a checkpoint's storage charge into the run total

#### test

- satisfy typecheck:tests across the usage test helpers
- update provider-api usage expectations to the disjoint contract
- guard against getAll() returning undefined in PostgresTabularDateTime test

#### deepseek

- map the stated cache-miss count to disjoint input

#### ai

- make the OpenAI-shaped usage mappers report disjoint input

#### job-queue

- retry promptly when an idle peek finds a ready job

### Refactors

- decompose BaseTabularStorage.ts and Task.ts along functional seams (#682)

#### tests

- streamline model info test function calls (fix type errors)

#### test

- drop the FsFolderTaskOutputRepository shim

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Performance

#### util

- add an incremental partial-JSON stream parser (#681)

### Tests

- fix out of date assertion in test
- run tests through Turbo and per-package vitest projects
- delete the unused Postgres task-output and task-graph repositories
- move 174 more unit tests into their owning packages
- settle the Bun policy, close a CI gap, and pilot the __tests__ move
- discover test files instead of enumerating sections
- add unit tests for OpenAI reasoning and temperature coupling, and Postgres date handling

#### huggingface-inference

- pin the estimate/stated boundary for HFI

#### ai

- verify OpenAI cache counters are portions of input_tokens
- pin the Usage field contract and assert disjointness

#### task-graph

- cover a nested task's spend reaching the run total
- relocate the remaining task-graph test infrastructure
- move TestTasks into the package's ./test entry
- extract the streaming task-output repository contract

#### providers

- drop a plan reference from a test comment
- cover checkpoint warm-up usage wiring

#### storage

- exercise a null criterion against a real index

### Documentation

#### build

- correct the surviving bun-condition count and pin it with a test (#716)

### Chores

- update deps
- add Lezer dependencies and update Vite configuration
- upgrade to catalog for many deps and update the deps themselves
- update deps

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

### Updated Dependencies

- `@aws-sdk/client-sqs`: catalog:
- `@cloudflare/workers-types`: catalog:
- `@types/dom-chromium-ai`: catalog:
- `@types/pg`: catalog:
- `aws-sdk-client-mock`: catalog:
- `fake-indexeddb`: catalog:
- `miniflare`: ^5.20260811.0-alpha
- `vitest`: catalog:

## 0.3.38

### Features

#### job-queue

- storage-only client reassembles the stream channel into onStream
- InMemory stream-channel reference carrier
- stream-channel contract + StreamReassembler
- capability-gated JobHandle.outputStream for cached binary results
- in-process stream observability via JobHandle.onStream

#### util

- transfer binary stream chunks across the worker boundary

#### test

- Supabase streaming cache backing
- tabular streaming cache backings (Postgres + SQLite)
- durable IndexedDB streaming task-output repository
- raw-IndexedDB chunked blob store for streaming cache

#### task-graph

- allow async getOutputStreamByRef for non-filesystem backings
- stream the run-private cache tier over an FsFolder backing
- backpressure gate on the no-accumulation passthrough edge
- cache-hit replay parity for non-binary refs (Task 6)
- no-accumulation passthrough — skip the materialize drain
- exempt stream-wired input ports from whole-value validation
- generalize stream sinks to all modes (per-port refs)
- per-mode stream codecs + port-aware repo stream sink
- add optional port/mode axis to CacheRef
- FsFolderTaskOutputRepository with streaming blob sidecar files
- hydrate cache refs in task inputs before execute
- cache-hit replay and hydration of binary cache refs
- expose binary stream-consumer detection for cache-hit replay
- resolveJobOutputStream for streaming job results from cache
- streaming read helpers for cache refs
- binary-streaming framework + result-as-reference

#### ai

- add a uniform usage telemetry channel

### Bug Fixes

- restore branch-final content drifted during the rebase onto main

#### task-graph,util

- close storage and worker review findings

#### job-queue

- close stream-channel review findings
- harden the cross-process stream channel
- stream-channel code-review fixes

#### task-graph

- close streaming engine review findings
- fail passthrough edge gates on abort and enforce watchdog liveness
- make BinaryStreamRouter push/end race-safe
- restrict portless outputStream discovery to declared streamable ports
- reject same-backing CacheRegistry misconfiguration at run start
- netstring-encode runScopePrefix to close sanitize collision
- route RunPrivateCacheRepo by-ref through *ForRun to prevent cross-run leak
- correctness fixes from branch-wide streaming review
- replace-mode streams must carry a value, else error
- stamp FsFolder blobs with unique suffix to prevent orphan-cleanup races
- fsync blobs directory after rename to survive crashes between rename and dir-metadata flush
- treat all class instances as opaque in ref walker
- clean up orphan blobs when stream-write succeeds but row commit fails
- treat Error and URL as opaque leaves in ref walker
- guard resolveOutput walker against cycles and shared subtrees
- default blob/binary port codecs for JSON-row cache backings
- cache rows store refs, not inline binary; enforce single-binary-port streaming
- blob lifecycle hardening in FsFolderTaskOutputRepository
- byte-bounded backpressure in binary stream router (default 8 MiB)
- canonicalize binary stream format vocabulary to "blob"|"binary"
- brand CacheRef with literal kind to prevent shape-only collisions

#### util

- transfer only fully-owned buffers for worker stream chunks

#### test

- cast Uint8Array to BlobPart in streaming-port test repos

#### ai

- record usage telemetry for the multi-turn chat tasks
- sum every chat turn's usage onto the outer finish
- record usage telemetry when a stream consumer stops early

#### mlx

- report the stub provider as unavailable and skip registration

### Refactors

#### task-graph

- extract BackpressureGate from BinaryStreamRouter
- remove dead pipeBinaryToCache; detach edge-stream listeners on abort/error

### Tests

#### task-graph

- await streaming reader in stream-out contract suites
- widen Uint8Array to ArrayBuffer-backed for Blob construction
- lock delta-wins on the StreamProcessor path

## 0.3.37

### Features

#### storage

- add an `in` set-membership operator to SearchCriteria

#### dataUri

- implement dataUriToBlob function for decoding data URIs to Blobs

### Bug Fixes

- data-URI decode order, own() tracking for functions, UI wiring
- bound CLI listener retention, reject double-own, decode binary data URIs

### Tests

- cover wrapper removal that bypasses disown

### Documentation

#### test

- correct the empty-in-list comment in the Supabase mock

## 0.3.36

### Features

#### PostgresTabularStorage

- add regression tests for upsert behavior on all-primary-key tables

## 0.3.35

### Features

#### task-graph

- add context.disown so owners can release finished subtasks

### Bug Fixes

#### anthropic

- stop sending sampling params to models that reject them

## 0.3.34

### Features

#### cli

- show the work inside an owned workflow, not just its wrapper row

### Bug Fixes

- address code-review findings across the three hardening fixes

#### deepseek

- make tool_choice violations actually retryable

#### storage

- eliminate latent shim deadlock on same-owner tx re-entry

### Refactors

- update maxTokens description and implement reasoning allowances

### Chores

- update deps

### Updated Dependencies

- `@types/pg`: ^8.20.3

## 0.3.33

### Features

#### deepseek

- add DeepSeek AI provider

### Bug Fixes

#### deepseek

- correct json-mode and tool_choice for the real API

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1101.0
- `@cloudflare/workers-types`: ^5.20260801.1
- `@types/pg`: ^8.20.2

## 0.3.32

### Bug Fixes

- unwrap interpreter values to return plain JavaScript arrays and objects

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1100.0
- `@cloudflare/workers-types`: ^5.20260731.1
- `miniflare`: ^4.20260730.0

## 0.3.30

### Features

#### tf-mediapipe

- chatml template; Qwen2.5 default genai model, gated-Gemma note
- wire genai run-fns, capability inference, model search, previews; document gpu + genai
- genai text-generation, structured-generation, count-tokens run-fns
- delegate injection, GPU fallback, deep options cache, pinned genai wasm
- gemma chat template renderer
- pure delegate resolution for gpu option

### Bug Fixes

#### tf-mediapipe

- single-flight genai creation, lock-guarded teardown, drop unusable setOptions overrides

### Tests

#### gemini

- pin thinking_budget in the live conformance model record

## 0.3.29

### Bug Fixes

#### storage

- browser-safe cross-instance re-entry + actionable ConnectionReentryError
- BigInt-safe primary-key fingerprint in bulk paths
- share a connection mutex across storages bound to one handle

#### util,llamacpp

- tenant-scope id and per-session mutex prep

### Tests

#### gemini

- stub structured NOT_FOUND matcher suite pending fallback file

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1098.0
- `@cloudflare/workers-types`: ^5.20260730.1
- `miniflare`: ^4.20260722.1

## 0.3.28

### Features

#### storage

- add support for JSONB column binding in PostgresTabularStorage

## 0.3.27

### Bug Fixes

#### storage

- honor clientProvidedKeys 'never' in bulk putBulk; refresh docs

#### duckdb

- keep putBulk idempotent on all-primary-key tables

#### supabase

- collision-safe composite-key fingerprint in putBulk dedup

#### ai

- stop AiTask.narrowInput from mutating its input argument

#### knowledge-base

- route console.warn through structured logger

#### indexeddb

- make tabular putBulk atomic via single transaction

#### openai

- surface silent Responses-API regressions from 0.3.26 (H2)

#### huggingface-transformers

- sweep hftSessions on LRU pipeline eviction (H1)

### Performance

#### storage

- single-statement putBulk engine + SQLite backend

### Tests

#### storage

- SQL bulk putBulk refinements + atomicity

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1092.0
- `@cloudflare/workers-types`: ^5.20260721.1
- `miniflare`: ^4.20260721.0

## 0.3.26

### Features

- add Workglow Eval: CLI harness for model evaluation on HuggingFace datasets (#636)

#### storage

- add DuckDB tabular storage backend (@workglow/duckdb) (#635)

### Bug Fixes

#### node-llama-cpp,huggingface-transformers

- concurrency + sequence-leak + bounded pipeline cache (#634)

#### node-llama-cpp

- eviction disposes embedding, broaden isVramError, retry embedding create
- address review feedback on VRAM/LRU/sequence handling

#### huggingface-inference

- guard chunk.choices[0] in streaming run-fns

#### ai

- key OpenAIShapedResponses tool-call accumulator on stable item id

#### xai,openrouter

- guard chunk.choices access and downshift strict schema

### Tests

#### huggingface-transformers

- regressions for H1 (refcount race) and H2 (AbortController key)

### Chores

- update deps

#### deps

- update @cloudflare/workers-types to 5.x and tslog to 5.x

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1088.0
- `@cloudflare/workers-types`: ^5.20260715.1
- `miniflare`: ^4.20260710.0

## 0.3.25

### Features

- add OpenRouter provider for @workglow/ai (#626)

#### providers

- add xAI (Grok) AI provider(#622)

### Bug Fixes

#### storage

- genuine CAS for updateWhere on IndexedDb + HttpTabularProxy (#628)

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Bug Fixes

#### google-gemini

- migrate to @google/genai; fix thinking-model tool calls and structured output (#620)

#### util

- make objectOfArraysAsArrayOfObjects work with native array methods

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1084.0
- `miniflare`: ^4.20260708.1
- `vitest`: ^4.1.10

## 0.3.23

### Features

#### supabase

- updateWhere CAS via filtered update().select()

#### storage

- InMemory updateWhere CAS

### Bug Fixes

#### storage

- updateWhere rejects patches that change a primary-key column
- make updateWhere single-row and consistent across backends

#### util

- make objectOfArraysAsArrayOfObjects work with native array methods

### Refactors

- consolidate hardcoded limits into DEFAULT_LIMITS/SECURITY_LIMITS (#609)

### Tests

#### gemini

- disable the gemini-2.5-flash live conformance suite (model retired)

#### storage

- regression tests for InMemory updateWhere invariants
- seed required createdAt/updatedAt in updateWhere suite
- generic updateWhere CAS suite

### Chores

- update deps
- format / lint

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1084.0
- `miniflare`: ^4.20260708.1
- `vitest`: ^4.1.10

## 0.3.22

### Bug Fixes

#### review

- resolve xhigh code-review findings on cherry-picked 601+604

#### util/di

- drain eviction disposals and clear stale factories on registerInstance
- dispose previously cached singleton on register replacement

#### task-graph/cache

- require liveRunIds callback and drop unguarded fast-path

#### task-graph

- swap nonexistent storage.search for query in clearOlderThan
- clean up listeners on reader.cancel() in createStreamFromTaskEvents
- stamp saturating depth on over-cap bridge + dedupe warn per parent
- cap bridgeSubGraphTaskEvents depth to prevent event amplification
- bubble subgraph events from iterator/map/reduce loops (#599)

#### storage/vector

- align in-memory + IndexedDB default scoreThreshold to 0 (match SQL backends)

#### core

- resolve review findings across util, storage, job-queue, task-graph (#602)

#### test

- drop over-broad cast on observeFinish in accumulator test

#### ai

- make StreamEventAccumulator delta-wins to stop tool-call clobber

#### providers

- map Gemini sampling params; add Ollama json-mode support

### Performance

#### task-graph

- stream distinct runIds via queryPage in clearOlderThan

### Tests

#### ollama

- unit-test the structured-generation streaming run-fn

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1079.0
- `@cloudflare/workers-types`: ^4.20260702.1
- `miniflare`: ^4.20260701.0

## 0.3.20

### Features

#### task-graph

- bubble subgraph events for While and Fallback (data) groups
- emit and bubble per-task task_progress events
- bubble subgraph events from streaming groups too
- bubble subgraph task events up to the parent graph
- emit graph-level task_complete event per finished task

### Bug Fixes

#### task-graph

- only emit task_progress while a task is actively running
- harden task_complete emit against throwing listeners

#### huggingface-transformers

- resolve server device to undefined instead of "auto" (#597)

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1075.0
- `@cloudflare/workers-types`: ^4.20260624.1
- `miniflare`: ^4.20260623.0

## 0.3.19

### Features

#### huggingface-transformers

- add HFT_Device module and related tests

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1074.0

## 0.3.18

### Tests

#### fix

- hmac

## 0.3.17

### Features

#### util

- add Hmac utility

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260621.1

## 0.3.16

### Bug Fixes

#### providers/sqlite

- vector encoding inside withTransaction + nested-BEGIN deadlock (#594)

### Refactors

#### storage

- enhance unique index handling and event emission

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1073.0
- `@cloudflare/workers-types`: ^4.20260619.1
- `miniflare`: ^4.20260617.1
- `vitest`: ^4.1.9

## 0.3.15

### Features

#### storage

- add uniqueIndexes for DB-level UNIQUE constraints + dedup overlapping regular indexes (#593)

### Bug Fixes

- eslint fixes

#### providers/sqlite

- wrap putBulk vectors with vector_as_*() to match put (#590)

#### storage

- include rolled-back ids in rollback event payload (#591)

#### storage,indexeddb,postgres,sqlite

- cumulative vector-storage validation + atomicity hardening (#580/#581/#583/#584/#587) (#589)

#### test

- playwright
- browser use task tests disposing early

#### mcp,supabase

- credential-leak fail-closed + vector dim validation (2 HIGH from code review) (#579)

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

#### supabase

- add Supabase vector storage with pgvector support (#578)

### Bug Fixes

#### mcp

- thread run-scoped registry through discoverSchemas (#577)
- resolve auth credentials through the run-scoped registry

#### task-graph,storage

- cache restart-resume + SharedInMemory sync barrier (#552)

### Tests

- pin HF router provider for tool-calling conformance tests (#564)

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1068.0
- `@cloudflare/workers-types`: ^4.20260612.1
- `@types/dom-chromium-ai`: ^0.0.17
- `miniflare`: ^4.20260611.0

## 0.3.13

### Refactors

- optimize task output repository implementations
- streamline TaskOutputTabularRepository and enhance task graph wrappers
- unify task output storage implementation
- update cache keying for private slots to use taskId

## 0.3.12

### Bug Fixes

#### storage

- reject puts to credential-store sentinel key

#### ai

- align IPv6 loopback check with isLoopbackHostname
- label-boundary match on provider base-URL host allow-list

### Refactors

- rework delete events

### Style

#### ai

- apply prettier formatting to baseUrlValidation tests

### Tests

#### ai

- add IPv6 + redirect-canonicalisation localOnlyFetch tests (#543)

### Chores

- update deps
- comment review pass across packages and providers
- update dependencies to latest versions

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1063.0
- `@cloudflare/workers-types`: ^4.20260605.1
- `miniflare`: ^4.20260603.0

## 0.3.11

### Bug Fixes

#### storage,ai

- SQL operator allow-list + baseURL validation + credential-store passphrase sentinel (#546)

## 0.3.10

### Bug Fixes

#### ai

- close WHATWG canonicalisation bypass in localOnlyFetch (sec) (#542)

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1060.0
- `@cloudflare/workers-types`: ^4.20260603.1
- `miniflare`: ^4.20260601.0
- `vitest`: ^4.1.8

## 0.3.9

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1055.0
- `@cloudflare/workers-types`: ^4.20260528.1
- `miniflare`: ^4.20260526.0

## 0.3.8

### Features

- add provider runtime metadata: supportsServer and isAvailable() (#538)

### Bug Fixes

- close redirect-based SSRF bypass in local provider fetches (sec) (#536)

## 0.3.7

### Features

#### storage

- add HttpTabularProxyStorage for remote table operations (#534)

### Bug Fixes

#### ai,llamacpp-server,stable-diffusion-server

- strict local-only URL allow-list (sec) (#533)

## 0.3.6

### Features

#### ai

- IBackendsTransport interface + provider package scaffolding

#### cactus

- SHA-256 integrity verification for fetched model assets (#530)

### Bug Fixes

#### cactus,chrome-ai

- security and correctness fixes from review (#531)

### Tests

#### stable-diffusion-server

- full unit and integration test suite

#### llamacpp-server

- full unit and integration test suite

### Chores

- update deps, turn off preview libs for now

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1053.0
- `@cloudflare/workers-types`: ^4.20260523.1
- `miniflare`: ^4.20260521.0

## 0.3.5

### Features

#### chrome-ai

- enhance WebBrowser provider with new capabilities and session management

#### cactus

- enhance Cactus_ModelInfo to report cache status and file sizes

### Bug Fixes

- Chrome-ai (#514)

### Chores

- update @cloudflare/workers-types dependency to version 4.20260522.1 across multiple package.json files

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260522.1

## 0.3.4

### Features

#### cactus

- add browser-specific AI provider classes and registration functions

## 0.3.2

### Features

- add Cactus (needle-rs) local tool-calling provider (#524)

### Refactors

- remove pre-v1 backward-compat code paths (#523)

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1052.0
- `@cloudflare/workers-types`: ^4.20260521.1
- `miniflare`: ^4.20260520.0

## 0.3.0

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

#### task-graph

- policy-driven cache layer with durable execution

#### cloudflare

- Cloudflare Queues message-queue adapter (@workglow/cloudflare)

#### aws

- SQS message-queue adapter (@workglow/aws)

#### job-queue

- IJobStore decomposition + processClaims for cloud transports

### Chores

- format
- update deps

### Updated Dependencies

- `vitest`: ^4.1.7

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

#### ai

- update image input handling across vision tasks
- enhance HuggingFace model configuration and pipeline mapping

#### job-queue

- enhance error handling with machine-readable codes

### Bug Fixes

- FetchUrl permanent codes + SQLite v4 + error-code registry (#518)

#### job-queue

- follow-up correctness fixes to PR #511 (#513)

### Refactors

#### tests

- streamline timer handling with advanceFakeTimers utility

#### job-queue

- drop legacy limiter methods, fix QueuedExecutionStrategy release, rename releaseClaim (#511)

### Tests

- fix description text changed
- add tabular-storage contract invariant suite across all backends (#510)

### Chores

- update configuration files and improve code organization

## 0.2.36

### Features

#### kb

- pluggable strategy with model config, IRunConfig threading, and document tasks

#### hft

- add text reranker capability with pipeline shape validation

### Bug Fixes

#### util/worker, ai/task

- TTL-based pendingAborts eviction; clarify runWithIterable bond (#500)

#### ai

- avoid NaN reranker scores for empty queries
- escape regex metacharacters in RerankerTask.simpleRerank
- classify provider-error vs no-finish in AiTask.execute
- replace runWithIterable Proxy with shallow clone

#### util

- snapshot-then-delete eviction in WorkerServerBase Set caps

### Tests

- move tests so we we don't need a list of files per provider in the test script

## 0.2.35

### Features

#### tests

- add comprehensive tests for AiChatTask and AiChatWithKbTask

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

- emit kv storage events from concrete implementations (#481)

#### test,ai

- align AiChatWithKbTask disposer test with model.dispose lookup

#### util/worker

- apply aborts that arrive before the call starts

#### ai,hft,test,ci

- resolve RAG WASM/ONNX memory leaks

#### ai,providers,test

- Phase 5 review feedback and CI/test fixes

#### knowledge-base,storage,postgres

- cross-KB getBulk leak + restore Postgres-native hybrid search (#486)

#### storage-migrations

- serialize concurrent runs and roll back partial SQLite schema (#485)

#### ai

- emit iterations on finish + composite kb:doc key + clarify text schema

### Refactors

#### ai

- finalize Promise+emit migration and cleanup
- migrate execution path to Promise+emit shape

#### providers

- migrate all providers to AiProviderRunFnRegistration[] (Phase 5)

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Tests

#### ai/task

- streaming consumer abort propagates to provider strategy

#### ai,timing

- align fixtures and add memory tooling for Promise+emit

#### rag

- share ResourceScope across workflows to keep models warm (#487)

#### sqlite-vector

- add @sqliteai/sqlite-vector to packages/test and fix ESM extension loading (#492)

### Documentation

- add design for storage getBulk plural-get (#480)

### Chores

- drop scratch bridgeProgress-leak-repro artifact
- release 30 packages
- release 30 packages

#### dependencies

- update package versions and lockfile, and remove bun tests from CI

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

### Updated Dependencies

- `vitest`: ^4.1.6

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

### Bug Fixes

- emit kv storage events from concrete implementations (#481)

## 0.2.32

### Features

- introduce IEntitlementProfile with signal-source port and conformance suite (#469)

#### storage

- SQL DDL builders for tabular migrations
- runBackfill helper for tabular migrations
- real-pool path for Postgres withTransaction + reflection-based createTxView
- cursor-based pagination for stable iteration under writes
- mutex-serialize SQLite + Postgres tabular ops to close withTransaction concurrency hole

#### test

- IHumanConnector contract conformance suite (#471)

### Bug Fixes

- merge issues with tests

#### tabular-migrations

- address Copilot review feedback

#### ollama

- make streaming AbortSignal optional and harden race window (#466)

#### llamacpp

- release transient chat sessions before session-reuse test (#467)

#### storage

- address Copilot review feedback on cursor pagination + transactions
- address Copilot review on bigint/Date and mock parser
- NULL handling in compound keyset paths + new tests
- CI build + Copilot review feedback
- address code-review follow-ups on cursor pagination

#### knowledge-base

- reject cursors minted by a different KB scope

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- remove setupDatabase() from queue/rate-limiter, plumb migration progress

#### browser-control

- split backends into per-vendor provider packages

#### storage

- streamline validation and error handling for orderBy criteria
- address Copilot review on withTransaction semantics
- address review feedback on putBulk + withTransaction

### Tests

- implement AiProvider contract conformance suite (#461)

#### tabular

- per-backend contract conformance tests (Phase 9)
- contract suite (10 files)

#### indexeddb

- smoke test for tabular backfill migration

#### postgres

- smoke test for tabular addColumn migration

#### sqlite

- smoke test for tabular addColumn migration

#### storage-migrations

- tighten contract MEDIUMs
- numeric sort + multi-component ordering + recorder convergence
- add concurrentRunsSerialize + failedMigrationLeavesNoPartialSchema
- contract conformance suite for IMigrationRunner (#464)

#### contract

- implement worker-proxy contract conformance suite (#468)

#### browser-context

- add IBrowserContext contract conformance suite (#470)

#### ai-provider

- add positive capability honesty assertions (#465)

### Chores

- fix merge issues after rebase and do a format

#### tabular-migrations

- final formatting + scripts/test.ts wiring

#### storage

- pre-merge polish from final review (easy minors)

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Refactors

#### tests

- move Dataflow and transform tests

## 0.2.29

### Refactors

#### ai-provider

- enhance model search functionality

## 0.2.28

### Refactors

- update libs imports for queue/limiter symbols moved to @workglow/job-queue

#### mcp

- move MCP tasks and util from @workglow/tasks to @workglow/mcp

#### browser-control

- move browser-control backends from @workglow/tasks to @workglow/browser-control

#### javascript

- move JavaScriptTask + interpreter from @workglow/tasks to @workglow/javascript

#### ai-provider

- final trim of vendor subpaths and SDK peers

#### tf-mediapipe

- move provider from @workglow/ai-provider to @workglow/tf-mediapipe

#### node-llama-cpp

- move provider from @workglow/ai-provider to @workglow/node-llama-cpp

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

- code-review cleanup
- format

## 0.2.27

### Features

#### storage

- enhance queryIndex functionality and add tests

### Bug Fixes

#### job-queue

- release by token to fix wrong-row deletion under contention

#### storage

- export SharedInMemoryTabularStorage from common-server for tests

### Tests

#### job-queue

- atomic-limiter and same-process worker coverage

## 0.2.26

### Features

#### storage

- Sqlite + Postgres queryIndex with column projection
- IndexedDbTabularStorage.queryIndex via openKeyCursor
- InMemoryTabularStorage.queryIndex
- pickCoveringIndex pure helper for queryIndex
- CoveringIndexMissingError for queryIndex

### Bug Fixes

#### storage

- address review on queryIndex (#453)

### Style

#### storage

- align CoveringIndexMissingError license header

### Tests

- fix

#### storage

- conformance cases for queryIndex across all backends

#### task-graph

- enhance RunPreviewStream tests with setup and utility functions

### Chores

- format

## 0.2.25

### Features

#### task-graph

- TaskRunner.run() throws on concurrent re-entry
- TaskGraphRunner.runGraph auto-creates ResourceScope when none passed
- TaskRunner.run auto-creates ResourceScope when none passed

### Bug Fixes

#### task-graph

- address Copilot PR review on ResourceScope auto-ownership
- await handleError in runGraph epilogue

#### test

- prevent HFTransformersBinding beforeEach timeout (#449)

### Refactors

#### tests

- replace setTimeout with sleep utility for improved readability

#### task-graph

- update port codec registration and improve test coverage
- per-run streaming unsub + real spec #7/#8 coverage
- extract DSL state machine to WorkflowBuilder

### Tests

- bun 1.3.13 panics often and makes tests slow
- quick fix

#### job-queue

- add waitForCondition utility for job deletion verification

#### task-graph

- runPreview does not auto-create or thread ResourceScope
- failure-path coverage for ResourceScope auto-ownership
- strengthen Task 5 forwarding tests + add iterator coverage
- nested-run forwarding disposes exactly once under auto-ownership
- add `await using` regression for caller-passed ResourceScope
- add unit tests for TaskRunContext, StreamProcessor, CacheCoordinator
- add unit tests for Workflow internal seams
- apply review feedback to Workflow refactor regression net
- fix type errors in Workflow refactor regression net
- add Workflow refactor regression net
- add unit tests for RunScheduler, EdgeMaterializer, StreamPump

### Chores

- format

## 0.2.24

### Features

#### storage

- implement count method across storage backends

### Refactors

#### job-queue

- same-process hot-path optimization + correctness fixes (#426)

### Chores

- format

## 0.2.23

### Bug Fixes

#### test

- enhance preview output handling in TaskRunner

## 0.2.21

### Features

#### ai

- default phase emission and per-subclass phase labels
- image generation pipeline with ImageValue boundary

#### task-graph

- indeterminate progress and StreamPhase events

## 0.2.20

### Chores

#### util,storage

- introduce fast deepEqual; replace JSON.stringify equality

## 0.2.19

### Features

#### task-graph

- introduce runWithPreviews flag for subgraph execution

## 0.2.18

### Features

#### tasks/image

- ImageTextTask.executePreview applies preview-scale to fontSize/dims
- scalePreviewParams hook + 5 filter overrides; fallback preserves previewScale
- add CSS rgb/rgba color schema and validation
- task-layer CPU fallback when backend filter arm is missing
- per-mode lifecycle in ImageFilterTask; resourceScope output disposer

#### util/media

- previewSource composes scale via \_setPreviewScale
- GpuImage carries previewScale; backends implement; apply() propagates

#### util/media, tasks/image

- real WGSL shaders for 16 image filters
- refcount-based GpuImage lifecycle; eliminate releaseSource

#### task-graph

- refcountable predicate registry; runner retains for fanout safety

#### util/media, tasks

- previewSource downscales WebGPU images at the chain head

#### util/media, tasks/image, ai, task-graph

- GpuImage pipeline (Phases 1-8)

### Bug Fixes

- test

#### tasks/image

- hydrateInput handles ImageBinary, Blob, ImageBitmap, and data: URIs

### Refactors

#### tasks/image

- consolidate image filter operations and update imports
- remove ImageWatermarkTask

#### util/media, tasks/image

- colocate WGSL per filter; apply.shader is raw string

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
- add color type system

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

#### task-graph

- dataflow transforms engine with autoConnect refactor

### Bug Fixes

- register image raster codec for AiVisionTask decoding
- add validation for outputSchema in StructuredGenerationTask, changes to tool use schema

### Refactors

#### ai

- simplify and consolidate RAG tasks (#427)

### Chores

- release 12 packages
- update deps

#### tests

- align timeout settings across Vitest and Bun

### Updated Dependencies

- `vitest`: ^4.1.5

## 0.2.15

### Features

#### util/media

- introduce Image class and consolidate image handling
- add color type system

#### tasks

- add ColorValueSchema and migrate image tasks
- enhance ImageTextTask input schema and validation

#### task-graph

- dataflow transforms engine with autoConnect refactor

### Bug Fixes

- add validation for outputSchema in StructuredGenerationTask, changes to tool use schema

### Chores

- update deps

#### tests

- align timeout settings across Vitest and Bun

### Updated Dependencies

- `vitest`: ^4.1.5

## 0.2.14

### Features

#### task-graph

- require explicit iteration bounds, document cycle guarantees, add forEach/if combinators (#424)

#### entitlements

- return structured denials with reason + add can() (#422)

### Tests

#### streaming

- detect reorder, fix abort race, correct cancel docs

### Documentation

#### streaming

- formalize primitive contract, cancel semantics, add stress tests

## 0.2.12

### Refactors

#### task-graph

- introduce isPassthrough flag for task types

## 0.2.11

### Refactors

#### tests

- streamline Chrome availability checks and add tests

#### task-graph

- enhance progress reporting in FallbackTaskRunner, IteratorTaskRunner, and WhileTask

## 0.2.10

### Refactors

#### kb

- update KnowledgeBase constructor to accept options object

## 0.2.9

### Features

#### kb

- stable public API for vector search and lifecycle hooks

#### ai

- StructuredGenerationTask validates output and retries on mismatch
- AiChatTask, canonical ChatMessage, and worker streaming

### Refactors

#### task-graph

- clean up imports and improve formatting

## 0.2.8

### Features

#### ai

- session caching for multi-turn AI tasks

## 0.2.7

### Features

#### browser-control

- add browser automation framework with multiple backends

#### util

- add ResourceScope for heavyweight resource lifecycle management

#### ai

- add KbToDocumentsTask and relax vector dimension check

#### tasks

- add ImageTextTask for rendering text onto images

### Refactors

#### ai-provider

- consolidate tool parsers, remove FunctionGemma, and add shared provider utilities

### Chores

- format
- update dependencies

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

### Tests

#### graph

- add NodeDoesntExistError handling in DirectedAcyclicGraph and enhance DirectedGraph tests

## 0.2.5

### Bug Fixes

#### tasks

- re-validate SSRF redirect targets against network:private grant scope (#407)

### Tests

#### ai

- add afterEach kb cleanup to DocumentUpsertTask test
- failing tests for DocumentUpsertTask metadata input

### Chores

- format

## 0.2.4

### Features

#### task-graph

- add subGraph entitlement subscription handling
- support multiple wildcards in entitlement resource patterns (#406)

## 0.2.3

### Features

- add SSRF protection to FetchUrlTask with dynamic entitlements (#405)

### Bug Fixes

- add image codec security limits and validation helpers (#404)

## 0.2.2

### Features

#### tasks

- enhance image processing capabilities (#402)

## 0.2.1

### Features

#### tasks

- add image processing task library (#395)

### Documentation

- subsystem documentation series (#394)

### Chores

- formatting
- update dependencies

### Updated Dependencies

- `vitest`: ^4.1.4

## 0.2.0

### Features

- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### cli

- keyring (#367)

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- auto-connect passthrough tasks (e.g. DebugLogTask) to downstream… (#373)

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### util

- target specific node pair in removeEdge instead of scannin… (#374)

#### schema

- add allOf support to schema helpers and cycle detection … (#388)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)
- resolve race condition in GraphAsTask.executeStream() (#378)

#### graph

- count actual edges in indegreeOfNode instead of slot pres… (#375)

#### tests

- update ScopedStorage tests for type safety

### Refactors

#### ai-provider

- improve tool call handling in Anthropic_ToolCalling

### Tests

#### ai-provider

- refine structured output test for tool calls
- enhance structured output test for tool calls

### Chores

- release 12 packages
- format changes

### Updated Dependencies

- `vitest`: ^4.1.3

## 0.1.3

### Features

- Task constructor signature, ToolCallingTask and AgentTask (#353)

#### util

- add schema validation for DataPortSchema and format annot… (#385)

#### ai

- add schema validation and duplicate prevention to ModelRepo… (#380)
- ToolCallingTask and AgentTask

#### knowledge-base

- implement shared-table mode for knowledge bases

#### entitlements

- add entitlement/permission system for tasks and workflows (#370)

#### cli

- keyring (#367)

### Bug Fixes

- improve error handling across EventEmitter, JobQueue, WorkerManager, and ConditionalTask (#386)
- auto-connect passthrough tasks (e.g. DebugLogTask) to downstream… (#373)

#### ai-provider

- emit incremental tool call deltas instead of full a… (#392)

#### util

- target specific node pair in removeEdge instead of scannin… (#374)

#### schema

- add allOf support to schema helpers and cycle detection … (#388)

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### task-graph

- prevent TaskRegistry from silently overwriting regis… (#377)
- resolve race condition in GraphAsTask.executeStream() (#378)

#### graph

- count actual edges in indegreeOfNode instead of slot pres… (#375)

#### tests

- update ScopedStorage tests for type safety

### Refactors

#### ai-provider

- improve tool call handling in Anthropic_ToolCalling

### Tests

#### ai-provider

- refine structured output test for tool calls
- enhance structured output test for tool calls

### Chores

- format changes

### Updated Dependencies

- `vitest`: ^4.1.3

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

### Refactors

- enable noImplicitOverride and update classes for TypeScript compliance

## 0.1.0

### Features

#### ai-provider

- enhance AI provider tests with new thinking model and tool updates
- enhance timeout handling and function calling local model support
- add RNG seed configuration for reproducible generation

#### queue-status

- remove JobQueueTask from the task class heirarchy

#### task-graph

- add graph-level timeout, task allowlist, and resource cleanup features (#339)

#### tests

- add dtype configuration for various models in ONNX and HuggingFace tests
- add vitest coverage for job queue, utilities, and tasks (#334)
- add new integration test steps for github actions

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

#### storage,knowledge-base

- security hardening, bug fixes, and robustness improvements (#341)

#### tasks

- security hardening, bug fixes, and robustness improvements (#337)

### Refactors

- remove array input support from most AI provider implementations (#333)

#### ai

- remove ToolCallingTask and related utilities
- decouple AI execution from job queue with strategy pattern

#### tasks

- consolidate MCP client utilities and add registry resolution for them to configs

### Tests

#### storage

- enhance PollingSubscriptionManager with initialization state management

### Chores

- remove unnecessary comments that restate code or reference commits
- remove implementation plan configuration schema and update README with build status badge
- update package dependencies (transformers to version 4.0.0-next.9)

#### dependencies

- update package versions for improved compatibility and features

### Updated Dependencies

- `@electric-sql/pglite`: catalog:
- `vitest`: ^4.1.2

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### storage

- move @workglow/sqlite package into @workglow/storage/sqlite and add @workglow/storage/postgresql

### Refactors

#### docs

- update import paths to use "workglow" instead of "@workglow" for consistency, sqlite all get init()

## 0.0.125

### Chores

#### dependencies

- update various package versions for improved stability and features

#### test

- mark test package as private and remove publish configuration

### Updated Dependencies

- `vitest`: ^4.1.1

## 0.0.124

### Features

#### ai-provider

- add displayName property to AiProvider and its implementations

### Refactors

#### task

- enhance input handling with Partial types

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

#### schema

- remove @workglow/schema package move to back to util

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

#### cli

- add detail commands for agent, MCP, model, task, and workflow

### Refactors

- update package exports to use source files instead of dist
- split the sdk off to worker only
- reorg ai-provider a bit more
- ai provider

#### ai-provider

- introduce queued providers for various AI models

#### util

- reorganize MCP-related and toolcalling related code

#### task

- improve JSON serialization logic in Task class

### Build

- no real point to splitting in the libs

### Chores

- update dependencies and enhance Vite configuration
- add @typescript/native-preview package and make updates for tsgo
- rename tests to represent storage

### Updated Dependencies

- `@electric-sql/pglite`: ^0.4.1

## 0.0.119

### Features

- add chrome web browser provider (#303)
- add Structured Generation support to HFT and LlamaCpp providers
- add generic AI provider integration test suite

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- resolve ai-provider test failures from mock leakage and env var … (#299)
- OpenAI schema compatibility for structured generation and stop tool
- revert streaming accumulation, keep test-only changes
- accumulate text in streaming finish events, add comprehensive provider tests
- improve type imports and message handling in AgentTask and tests

#### test

- enhance error handling in ModelDownloadAbort integration test

### Refactors

- unify tool call handling across providers
- simplify test gating and clean up documentation
- enhance tool handling and message conversion

### Chores

- update bun version and improve test cleanup
- update dependencies including upgrade to vite 8
- release 14 packages
- update dependencies in bun.lock and package.json
- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

### Updated Dependencies

- `@electric-sql/pglite`: ^0.4.0
- `vitest`: ^4.1.0

## 0.0.118

### Features

- add chrome web browser provider (#303)
- add Structured Generation support to HFT and LlamaCpp providers
- add generic AI provider integration test suite

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- resolve ai-provider test failures from mock leakage and env var … (#299)
- OpenAI schema compatibility for structured generation and stop tool
- revert streaming accumulation, keep test-only changes
- accumulate text in streaming finish events, add comprehensive provider tests
- improve type imports and message handling in AgentTask and tests

### Refactors

- unify tool call handling across providers
- simplify test gating and clean up documentation
- enhance tool handling and message conversion

### Chores

- update dependencies in bun.lock and package.json
- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

### Updated Dependencies

- `@electric-sql/pglite`: ^0.3.16

## 0.0.117

### Features

- add Structured Generation support to HFT and LlamaCpp providers
- add generic AI provider integration test suite

### Bug Fixes

- handle content block arrays in prompt for message conversion (#302)
- resolve ai-provider test failures from mock leakage and env var … (#299)
- OpenAI schema compatibility for structured generation and stop tool
- revert streaming accumulation, keep test-only changes
- accumulate text in streaming finish events, add comprehensive provider tests
- improve type imports and message handling in AgentTask and tests

### Refactors

- unify tool call handling across providers
- simplify test gating and clean up documentation
- enhance tool handling and message conversion

### Chores

- update dependencies and account for api changes
- update tsconfig to avoid node_modules
- update telemetry provider handling and GitHub Actions workflow

## 0.0.116

### Features

- add opentelemetry tracing (#292)
- add SqliteAiVectorStorage using @sqliteai/sqlite-vector extension (#291)
- add group and endGroup methods to Workflow for GraphAsTask support
- add graphToWorkflowCode utility for converting TaskGraph to Workflow code

### Bug Fixes

- pass DI registry explicitly in tests, add registry support to Workflow.run() (#287)
- update ONNX model configurations to use q8 quantization when on cpu as f16 not supported
- update ONNX model ID and dtype across multiple files

### Refactors

- clean up code formatting and imports across multiple files
- remove baseUrl from tsconfig and update exports in common-server.ts
- streamline task configuration and code generation in GraphToWorkflowCode

### Style

- fix prettier formatting in GraphToWorkflowCode files

## 0.0.114

### Updated Dependencies

- `@types/pg`: ^8.18.0

## 0.0.111

### Features

- implement MCP OAuth provider and authentication types (#266)

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

## 0.0.109

### Features

- introduce ModelInfoTask and enhance AiProvider with local and browser support properties

## 0.0.107

### Bug Fixes

- enhance HuggingFace Transformers provider with streaming and reactive tasks support

## 0.0.106

### Features

- add tool-calling command to CLI for sending prompts with tool definitionsl; improved toolcall

### Bug Fixes

- replace fixed sleep with poll loop in rate-limiter test to eliminate flakiness

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/ai@0.0.105
  - @workglow/ai-provider@0.0.105
  - @workglow/dataset@0.0.105
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
  - @workglow/util@0.0.90
  - @workglow/ai@0.0.90
  - @workglow/ai-provider@0.0.90
  - @workglow/dataset@0.0.90
  - @workglow/job-queue@0.0.90
  - @workglow/sqlite@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/ai@0.0.89
  - @workglow/ai-provider@0.0.89
  - @workglow/dataset@0.0.89
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
  - @workglow/dataset@0.0.88
  - @workglow/storage@0.0.88
  - @workglow/sqlite@0.0.88
  - @workglow/tasks@0.0.88
  - @workglow/util@0.0.88
  - @workglow/ai@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/ai@0.0.87
  - @workglow/ai-provider@0.0.87
  - @workglow/dataset@0.0.87
  - @workglow/job-queue@0.0.87
  - @workglow/sqlite@0.0.87
  - @workglow/storage@0.0.87
  - @workglow/task-graph@0.0.87
  - @workglow/tasks@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/ai@0.0.86
  - @workglow/ai-provider@0.0.86
  - @workglow/dataset@0.0.86
  - @workglow/job-queue@0.0.86
  - @workglow/sqlite@0.0.86
  - @workglow/storage@0.0.86
  - @workglow/task-graph@0.0.86
  - @workglow/tasks@0.0.86
  - @workglow/util@0.0.86

## 0.0.85

### Patch Changes

- Add FileLoaderTask and Ai tasks can use model config directly
- Updated dependencies
  - @workglow/ai@0.0.85
  - @workglow/ai-provider@0.0.85
  - @workglow/job-queue@0.0.85
  - @workglow/sqlite@0.0.85
  - @workglow/storage@0.0.85
  - @workglow/task-graph@0.0.85
  - @workglow/tasks@0.0.85
  - @workglow/util@0.0.85

## 0.0.84

### Patch Changes

- Fix model lookup for named entity rec
- Updated dependencies
  - @workglow/ai@0.0.84
  - @workglow/ai-provider@0.0.84
  - @workglow/job-queue@0.0.84
  - @workglow/sqlite@0.0.84
  - @workglow/storage@0.0.84
  - @workglow/task-graph@0.0.84
  - @workglow/tasks@0.0.84
  - @workglow/util@0.0.84

## 0.0.83

### Patch Changes

- Update definitions for secondary key array as const
- Updated dependencies
  - @workglow/ai@0.0.83
  - @workglow/ai-provider@0.0.83
  - @workglow/job-queue@0.0.83
  - @workglow/sqlite@0.0.83
  - @workglow/storage@0.0.83
  - @workglow/task-graph@0.0.83
  - @workglow/tasks@0.0.83
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
  - @workglow/tasks@0.0.82
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
  - @workglow/job-queue@0.0.80
  - @workglow/sqlite@0.0.80
  - @workglow/storage@0.0.80
  - @workglow/task-graph@0.0.80
  - @workglow/tasks@0.0.80
  - @workglow/util@0.0.80

## 0.0.79

### Patch Changes

- Merge and Split
- Updated dependencies
  - @workglow/tasks@0.0.79
  - @workglow/ai@0.0.79
  - @workglow/ai-provider@0.0.79
  - @workglow/job-queue@0.0.79
  - @workglow/sqlite@0.0.79
  - @workglow/storage@0.0.79
  - @workglow/task-graph@0.0.79
  - @workglow/util@0.0.79

## 0.0.78

### Patch Changes

- Added Input and Output tasks and rewrote deleteSearch to not be lame
- Updated dependencies
  - @workglow/ai@0.0.78
  - @workglow/ai-provider@0.0.78
  - @workglow/job-queue@0.0.78
  - @workglow/sqlite@0.0.78
  - @workglow/storage@0.0.78
  - @workglow/task-graph@0.0.78
  - @workglow/tasks@0.0.78
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
  - @workglow/tasks@0.0.77
  - @workglow/util@0.0.77
  - @workglow/ai@0.0.77

## 0.0.76

### Patch Changes

- fix array task reactive
- Updated dependencies
  - @workglow/task-graph@0.0.76
  - @workglow/ai@0.0.76
  - @workglow/ai-provider@0.0.76
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
  - @workglow/tasks@0.0.75
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
  - @workglow/tasks@0.0.74
  - @workglow/util@0.0.74
  - @workglow/ai@0.0.74

## 0.0.73

### Patch Changes

- Fix serious bug that made ai tasks fail
- Updated dependencies
  - @workglow/ai@0.0.73
  - @workglow/ai-provider@0.0.73
  - @workglow/job-queue@0.0.73
  - @workglow/sqlite@0.0.73
  - @workglow/storage@0.0.73
  - @workglow/task-graph@0.0.73
  - @workglow/tasks@0.0.73
  - @workglow/util@0.0.73

## 0.0.72

### Patch Changes

- Add Vision/Image tasks
- Updated dependencies
  - @workglow/ai-provider@0.0.72
  - @workglow/task-graph@0.0.72
  - @workglow/job-queue@0.0.72
  - @workglow/storage@0.0.72
  - @workglow/util@0.0.72
  - @workglow/ai@0.0.72
  - @workglow/sqlite@0.0.72
  - @workglow/tasks@0.0.72

## 0.0.71

### Patch Changes

- Add TextFillMaskTask and TextNamedEntityRecognitionTask
- Updated dependencies
  - @workglow/ai@0.0.71
  - @workglow/ai-provider@0.0.71
  - @workglow/job-queue@0.0.71
  - @workglow/sqlite@0.0.71
  - @workglow/storage@0.0.71
  - @workglow/task-graph@0.0.71
  - @workglow/tasks@0.0.71
  - @workglow/util@0.0.71

## 0.0.70

### Patch Changes

- Updates to download progress, etc
- Updated dependencies
  - @workglow/ai@0.0.70
  - @workglow/ai-provider@0.0.70
  - @workglow/job-queue@0.0.70
  - @workglow/sqlite@0.0.70
  - @workglow/storage@0.0.70
  - @workglow/task-graph@0.0.70
  - @workglow/tasks@0.0.70
  - @workglow/util@0.0.70

## 0.0.69

### Patch Changes

- Fix build
- Updated dependencies
  - @workglow/ai-provider@0.0.69
  - @workglow/ai@0.0.69
  - @workglow/job-queue@0.0.69
  - @workglow/sqlite@0.0.69
  - @workglow/storage@0.0.69
  - @workglow/task-graph@0.0.69
  - @workglow/tasks@0.0.69
  - @workglow/util@0.0.69

## 0.0.68

### Patch Changes

- Fix missing unload model task in worker version
- Updated dependencies
  - @workglow/ai-provider@0.0.68
  - @workglow/ai@0.0.68
  - @workglow/job-queue@0.0.68
  - @workglow/sqlite@0.0.68
  - @workglow/storage@0.0.68
  - @workglow/task-graph@0.0.68
  - @workglow/tasks@0.0.68
  - @workglow/util@0.0.68

## 0.0.67

### Patch Changes

- Add new tasks: UnloadModelTask, TextClassifierTask, TextLanguageDetectionTask
- Updated dependencies
  - @workglow/ai-provider@0.0.67
  - @workglow/tasks@0.0.67
  - @workglow/ai@0.0.67
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
  - @workglow/job-queue@0.0.66
  - @workglow/sqlite@0.0.66
  - @workglow/storage@0.0.66
  - @workglow/task-graph@0.0.66
  - @workglow/tasks@0.0.66
  - @workglow/util@0.0.66

## 0.0.65

### Patch Changes

- Add a subscription to task graph for child progress events
- Updated dependencies
  - @workglow/ai@0.0.65
  - @workglow/ai-provider@0.0.65
  - @workglow/job-queue@0.0.65
  - @workglow/sqlite@0.0.65
  - @workglow/storage@0.0.65
  - @workglow/task-graph@0.0.65
  - @workglow/tasks@0.0.65
  - @workglow/util@0.0.65

## 0.0.64

### Patch Changes

- Fix indexeddb queue to not mark completed on every progress message which made it look like it was retrying
- Updated dependencies
  - @workglow/ai@0.0.64
  - @workglow/ai-provider@0.0.64
  - @workglow/job-queue@0.0.64
  - @workglow/sqlite@0.0.64
  - @workglow/storage@0.0.64
  - @workglow/task-graph@0.0.64
  - @workglow/tasks@0.0.64
  - @workglow/util@0.0.64

## 0.0.63

### Patch Changes

- Fix more max try issues
- Updated dependencies
  - @workglow/ai@0.0.63
  - @workglow/ai-provider@0.0.63
  - @workglow/job-queue@0.0.63
  - @workglow/sqlite@0.0.63
  - @workglow/storage@0.0.63
  - @workglow/task-graph@0.0.63
  - @workglow/tasks@0.0.63
  - @workglow/util@0.0.63

## 0.0.62

### Patch Changes

- Update the queue system with fixes around max retries
- Updated dependencies
  - @workglow/ai@0.0.62
  - @workglow/ai-provider@0.0.62
  - @workglow/job-queue@0.0.62
  - @workglow/sqlite@0.0.62
  - @workglow/storage@0.0.62
  - @workglow/task-graph@0.0.62
  - @workglow/tasks@0.0.62
  - @workglow/util@0.0.62

## 0.0.61

### Patch Changes

- Update model config bugs with narrowing
- Updated dependencies
  - @workglow/ai@0.0.61
  - @workglow/ai-provider@0.0.61
  - @workglow/job-queue@0.0.61
  - @workglow/sqlite@0.0.61
  - @workglow/storage@0.0.61
  - @workglow/task-graph@0.0.61
  - @workglow/tasks@0.0.61
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
  - @workglow/tasks@0.0.60
  - @workglow/util@0.0.60
  - @workglow/ai@0.0.60

## 0.0.59

### Patch Changes

- Rework model config
- Updated dependencies
  - @workglow/ai-provider@0.0.59
  - @workglow/storage@0.0.59
  - @workglow/util@0.0.59
  - @workglow/ai@0.0.59
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
  - @workglow/ai@0.0.58
  - @workglow/sqlite@0.0.58
  - @workglow/tasks@0.0.58
  - @workglow/util@0.0.58

## 0.0.57

### Patch Changes

- Change JSON formats to use property name defaults instead of input
- Updated dependencies
  - @workglow/ai@0.0.57
  - @workglow/ai-provider@0.0.57
  - @workglow/job-queue@0.0.57
  - @workglow/sqlite@0.0.57
  - @workglow/storage@0.0.57
  - @workglow/task-graph@0.0.57
  - @workglow/tasks@0.0.57
  - @workglow/util@0.0.57

## 0.0.56

### Patch Changes

- Update TaskGraph to add subscriptions for status changes for tasks and dataflows
- Updated dependencies
  - @workglow/task-graph@0.0.56
  - @workglow/util@0.0.56
  - @workglow/ai@0.0.56
  - @workglow/ai-provider@0.0.56
  - @workglow/job-queue@0.0.56
  - @workglow/sqlite@0.0.56
  - @workglow/storage@0.0.56
  - @workglow/tasks@0.0.56

## 0.0.55

### Patch Changes

- Update deps
- Updated dependencies
  - @workglow/sqlite@0.0.55
  - @workglow/ai@0.0.55
  - @workglow/ai-provider@0.0.55
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
  - @workglow/tasks@0.0.54
  - @workglow/util@0.0.54
  - @workglow/ai@0.0.54

## 0.0.53

### Patch Changes

- Update FetchTask to use dynamic output schema
- Updated dependencies
  - @workglow/tasks@0.0.53
  - @workglow/ai@0.0.53
  - @workglow/ai-provider@0.0.53
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
  - @workglow/tasks@0.0.52
  - @workglow/util@0.0.52
  - @workglow/ai@0.0.52
