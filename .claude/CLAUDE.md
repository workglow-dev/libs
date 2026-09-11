# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Commands

Use **Node.js 24+**. The SQLite backend is the built-in `node:sqlite`, stable only from
Node 24 (experimental and flag-gated before that) — Vitest or `npx` under an older Node
produces misleading SQLite failures.

**TypeScript 7.** `tsc` is the native (Go) compiler, so `build-types` calls it directly and
there is no separate `tsgo` binary or `@typescript/native-preview` dependency any more.

```sh
bun run build              # Full build (packages + integrations + examples, via Turbo)
bun run build:packages     # Packages only
bun run build:types        # Type declarations only
bun run watch              # Turbo watch mode
bun run dev                # Turbo dev mode

bun run test               # bun test + vitest
bun run test:bun           # Bun native tests only
bun run test:vitest        # Vitest tests only
bun test <testfilename>    # One test file

bun run lint               # oxlint (+ tsgolint type-aware) across the repo; CI runs this
bun run format             # oxlint --fix + oxfmt write
bun run format-check       # oxfmt --check
bun run clean              # Remove dist, node_modules, .turbo, tsbuildinfo
```

**Run the narrowest test slice you can** — the full suite is very slow. Prefer
`bun scripts/test.ts <section> vitest` (see [Testing](#testing)).

## Linting

`oxlint` replaces ESLint; `oxlint-tsgolint` supplies the type-aware rules. One
`.oxlintrc.json` at the root covers every workspace -- oxlint walks up to find
it, so `bunx oxlint` works from any package directory. There are no per-package
`lint` scripts and no turbo `lint` task: the whole tree lints in under a second,
which is less than the fan-out cost.

`bun run lint` builds types first (`build:types`, turbo-cached) because
`--type-aware` resolves cross-package imports through `dist/*.d.ts`. Without
them every such import types as `any` and the type-aware rules quietly find
nothing instead of failing.

Two things ESLint checked that oxlint cannot: `eslint-plugin-regexp` (60 rules,
`no-super-linear-backtracking` among them -- the ReDoS guard) and
`react/no-deprecated`. Most type-aware rules are staged off with the finding
counts recorded beside them in the config; each is a cleanup of its own, not
part of the linter swap.

Disable comments still work spelled either way -- `eslint-disable-next-line` and
the ESLint plugin names (`@typescript-eslint/no-namespace`,
`react-hooks/exhaustive-deps`) both resolve -- so existing ones were left alone.

## Monorepo structure

Bun workspaces + Turborepo. Packages live in `packages/`, providers in `providers/`,
examples in `examples/`. Build order comes from Turbo's dependency graph (`turbo.json`).

```
util, sqlite            (foundation)
  → storage             (KV, Tabular, Queue, Vector abstractions)
  → job-queue           (scheduling, rate-limiting)
  → task-graph          (core DAG pipeline engine)
  → dataset, tasks      (KnowledgeBase, documents, chunks; utility tasks)
  → ai                  (AI task base classes, model registry, provider helpers)
     web-search         (WebSearchTask + provider registry; depends on tasks, NOT on ai)
  → providers/*         (anthropic, openai, gemini, ollama, ...)
  → test                (integration tests), workglow (meta-package), debug (DevTools formatters)
```

### Specs and plans live in the PRD repo

Cross-repo design specs and implementation plans belong in the sibling `prd` repo
(`prd/docs/superpowers/specs/` and `.../plans/`), which also carries skills to use.

**Never reference a plan, spec, PRD, or security-scan finding from a source comment**
("per plan …", "implements spec …", "see Task N in …", "C-1", "HIGH-2"). Those artifacts
change independently; comments must explain the code in front of them.

### Per-package build

Each package builds two runtime targets via `bun build --target=X`:
`src/browser.ts` → `dist/browser.js`, `src/node.ts` → `dist/node.js`, with `src/common.ts`
re-exported by both. Types via `tsc` (composite + incremental). Conditional `exports` in
`package.json` resolve per runtime.

**No `"bun"` export condition** — without one, Bun resolves `"import"` and loads the node
build. Adding one means a `src/bun.ts`, a `--target=bun` build and the export condition: a
third bundle and a third `.d.ts` to keep in sync for no behavior change. **Nothing in the
monorepo qualifies today.** `@workglow/util`'s `"."` and `"./worker"` were the last two,
for a `Worker.bun.ts` that was byte-identical to `Worker.browser.ts`; Bun implements
`node:worker_threads` over the same primitive as its web `Worker`, so a thread spawned
either way is reachable through `parentPort` and one `Worker.node.ts` serves Node and Bun
both. `@workglow/sqlite` `"./storage"` had gone the same way earlier, onto the shared
`node:sqlite` driver. The browser keeps its own build for the one reason Bun never had: a
static `node:worker_threads` import cannot be bundled for it. The empty set is pinned by
`packages/test/src/test/util/BunExportConditions.test.ts`, which fails until the fixture
and this paragraph are updated together.

Exceptions: `providers/*` ship `./ai` and `./ai-runtime` instead of browser/node. A vendor
may add further subpaths for surfaces outside the AI task framework: `@workglow/anthropic`,
`@workglow/openai`, `@workglow/openrouter` and `@workglow/google-gemini` also ship
`./web-search`, which implements `@workglow/web-search`'s provider interface and is loaded by
neither AI entry. `@workglow/util` has extra named exports — `/schema`, `/graph`, `/worker`,
`/media`, `/compress`.

## Code style

### TypeScript (from `.cursor/rules/`)

- **No default exports** — named exports only (except framework-required)
- **No enums** — `as const` objects, derive types with `keyof typeof`
- **`interface extends`** over `&` intersection (performance)
- **`readonly`** by default; omit only when genuinely mutable
- **`T | undefined`** over `T?` — force callers to be explicit
- **Discriminated unions** over bags of optionals
- **Explicit return types** on top-level module functions (except JSX components)
- **`import type`** for type-only imports; top-level `import type { T }`, not inline `{ type T }`
- **Never import from** `index`, `node`, `bun`, `browser`, `common` — import the specific module
- **`any` in generics is OK** when TS can't match runtime logic to types; elsewhere prefer `unknown`
- **`I` prefix** for public interfaces (`ITask`, `IKvStorage`, `IWorkflow`)
- **Concise JSDoc** only when behavior isn't self-evident; use `@link`; none for obvious code

### Formatting (`.oxfmtrc.json`)

Spaces, double quotes, semicolons, trailing commas (es5), 100 char width. Format with `oxfmt`
(`bun run format` / `bun run format-check`).

Imports are organized by the editor's TypeScript Organize Imports action on save
(`source.organizeImports`). Barrel and entry modules whose import order is load-bearing
(they register into `TaskRegistry` and the provider registries as a module side effect)
carry `// organize-imports-ignore`. The editor does not honor that marker; do not run
Organize Imports on those files.

### License header

Every source file starts with:

```ts
/**
 * @license
 * Copyright <YEAR> Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
```

`<YEAR>` is the year the file was **created**. Never bump it on an edit.

## Key packages

### `@workglow/task-graph` — core engine

See `packages/task-graph/README.md` and `src/EXECUTION_MODEL.md`.

**Task** — base class for pipeline nodes; implement `execute()` and optionally
`executePreview()`. Required statics: `type`, `category`, `title`, `description`,
`cacheable`, `inputSchema()`, `outputSchema()` (declared `as const satisfies DataPortSchema`).

**TaskGraph** — low-level DAG (`addTask`, `addDataflow`, `run`, `runPreview`).
**Workflow** — builder (`addTask`, `pipe`, `parallel`, `run`).
**Control flow** — `GraphAsTask`, `IteratorTask`, `MapTask`, `ReduceTask`, `WhileTask`,
`ConditionalTask`.

- `run()` → `execute()` — full run, cached, ends COMPLETED
- `runPreview()` → `executePreview()` — UI previews only, stays PENDING, must be fast
- Lifecycle: `PENDING → PROCESSING → COMPLETED | FAILED | ABORTED`

`taskGraphJsonShapeError` / `validateTaskGraphJsonShape` (`TaskGraphJsonShape.ts`) check a
`TaskGraphJson` structurally before `createGraphFromGraphJSON` touches it.

Schemas are JSON Schema. `format` annotations drive runtime type resolution
(`"model"`, `"model:EmbeddingTask"`, `"storage:tabular"`, `"knowledge-base"`);
`x-ui-manual: true` marks user-added ports. Register classes with `TaskRegistry.registerTask`.

### `@workglow/storage`

`IKvStorage`, `ITabularStorage`, `IQueueStorage`, `IVectorStorage` over InMemory, SQLite,
PostgreSQL, DuckDB, Supabase, IndexedDB, FsFolder. Storages emit `put`/`get`/`delete`/`deleteAll`.
`x-auto-generated: true` gives integers auto-increment and strings a UUID.

### `@workglow/knowledge-base`

`KnowledgeBase` owns document storage (tabular) and chunk storage (vector).
`createKnowledgeBase({ name, vectorDimensions })`; `registerKnowledgeBase` / `getKnowledgeBase`
/ `getGlobalKnowledgeBases` form a global registry that RAG tasks resolve string IDs against
at runtime. `TypeKnowledgeBase()` is the schema helper (format `"knowledge-base"`).

`Document` wraps a `DocumentRootNode` tree plus metadata; `ChunkRecord` is a flat chunk with
tree linkage (`nodePath`, `depth`); `ChunkVectorStorageSchema` / `ChunkVectorPrimaryKey` are
the vector storage schema. Key methods: `upsertDocument`, `upsertChunk`, `similaritySearch`
(or `search` with an installed `onSearch` callback), `clearChunks`, `getAllChunks`,
`putBulk`, `deleteDocument` (cascades to chunks).

### `@workglow/ai`

`AiTask`, `StreamingAiTask`, `AiVisionTask` extend `Task`; execution is delegated to an
`IAiExecutionStrategy` resolved per-model from `AiProviderRegistry`. Model system:
`ModelRepository`, `ModelRegistry`, `AiProviderRegistry`.

RAG tasks: `ChunkVectorUpsertTask` (`knowledgeBase` + `chunks` + `vector`, optional
`doc_title`), `ChunkRetrievalTask` (`knowledgeBase` + `query` + `model`, with
`method: "similarity" | "hybrid"`), `HierarchyJoinTask`, `RerankerTask`,
`QueryExpanderTask`, `TextChunkerTask`, `HierarchicalChunkerTask`.

`AgentTask` is the turn loop: one `ToolCallingTask` per round, then the tools the model asked
for, then their results back to it, until the model answers or `maxRounds` runs out.
`messages` goes in and comes back out, so the host owns the conversation. **Every `tool_use`
is answered** — an unknown tool, arguments failing the tool's schema, a throw, a person
declining — because dropping the call orphans it and the provider rejects the next round. A
tool is backed by a registered task (looked up by `taskType`, else `name`) or by a
`ToolDefinition.execute` function, which is handed a `ToolExecuteContext` — the tool-use id
its answer belongs to, and the run's signal — and may throw a `ToolCallError` to report a
failure in its own words rather than wrapped. The turn also emits a `snapshot` of `messages`
after every message it records, so a host can draw a tool card from the moment the model asks
for it; a `snapshot` rather than an object-delta because an array delta is folded as an upsert
list and successive whole-list snapshots would append into a transcript several times its
length. A tool reaching beyond `INFERENCE_ENTITLEMENTS` is put to
`IHumanConnector` as a `confirm` first: `requiresApproval` overrides that per tool,
`approval: "never"` turns it off for a headless run, and with no connector registered such a
call is refused rather than run.

Conversation helpers for a host keeping its own message list, none of which run inside a
task: `normalizeHistoryForModel` / `trimHistoryForModel` (`ChatHistory.ts`), and
`collectToolUseIds` / `uniquifyToolCallIds` / `repairDuplicateToolCallIds` (`ToolCallIds.ts`).

`validateModelAuthoredSchema` (`ModelAuthoredSchema.ts`) bounds a JSON Schema a model wrote
before a host renders a form from it, beside `sanitizeToolArgs`, which bounds the arguments.

**Cache checkpoints** — `CacheCheckpointTask` (requires `["cache.checkpoint"]`) warms a
prompt prefix and emits a `checkpoint` handle (`format: "cache-checkpoint"`) that
`ToolCallingTask` / `TextGenerationTask` / `AiChatTask` accept to send only the tail;
the first two can `emitCheckpoint` to chain a new one. An emitted checkpoint supersedes
its parent unless `keepParentCheckpoint`; all are run-scoped and disposed with the run's
`ResourceScope`. Providers map them to their own primitive (Anthropic `cache_control`,
OpenAI prefix replay, Gemini server-side `CachedContent`, local providers KV sessions).
Run-fns receive an `AiSessionContext` (`sessionId`, `emitCheckpointId`, `prefix`,
`ownedSession`) rather than a scalar session id; inject a shared `resourceScope` in the run
config to share checkpoints across separate runs. Details on the per-provider degradation
paths (including OpenAI's derived `prompt_cache_key`) live with those types.

### `@workglow/web-search`

`WebSearchTask` plus a provider registry. One normalized shape serves both plain search APIs
and model-grounded search: `results` is always present (for a grounded provider these are its
citations), and `answer` only from providers that synthesize one.

**Server-side only.** Every commercial search API authenticates with a request header, which
forces a CORS preflight none of them answer, and a browser-executed search would expose the
key to any visitor. The browser entry registers the **task** (so a builder UI can render and
validate the node) and **no providers**; running it there throws from the registry.

Providers declare a `WebSearchCapabilities` record and the task enforces it. `domainFilter` is
three-valued — `"native"`, `"query-operator"` (the task rewrites the query with `site:`), or
`false`. `excludeDomainFilter` defaults to `domainFilter` and exists because OpenAI's
`web_search` takes `filters.allowed_domains` with no blocked equivalent; `exclusiveDomainDirections`
exists because Anthropic's takes one list or the other, never both. Over-declaring is the
failure the whole record prevents: `"auto"` would route an option to a provider that cannot
honor it and the adapter would throw after selection rather than before.

Date filtering is **never emulated** — post-filtering by `publishedDate` breaks `maxResults`
and drops every result whose date the provider omitted, so `dateFilter: false` means such a
request is refused rather than approximated. The other half of that rule is that a provider
declaring `dateFilter: true` has to send something for every range this task accepts: both
Brave's `freshness` and Gemini's `timeRangeFilter` take a closed interval, so a half-open
range is filled at the open end. Dropping it reports a bound as honored on a search that ran
unfiltered, which is worse than refusing the request.

A domain entry naming no domain is refused for the same reason, and for **every** provider
rather than only the ones translating to `site:`. An entry cannot be empty or carry
whitespace, parentheses or quotes — a host cannot contain them, so such a value is not a
malformed domain but a value the caller did not mean (most often a list pasted into one
entry), and there is no portable `site:` quoting to rescue it with anyway. Dropping it
silently is the same trade the date rule refuses, one step worse: the `site:` translation
emits no clause for an empty list and the task clears the list afterwards, so one bad entry
in a single-entry list removes the restriction from both paths and the search runs across the
whole web, succeeds, and reports nothing. Validating for every provider is what keeps the
same entry from being refused on one route and forwarded verbatim to a vendor API on another.
`queryOperators` keeps filtering as a backstop, so no future call site can splice a value
that restructures a query.

`provider` is a required input with no default, mirroring `response_type` on `FetchUrlTask` —
which provider serves a request decides its cost, rate limit and quality. `"auto"` opts into
capability routing; the provider that ran is always reported on the `provider` output port. A
**pinned** provider that cannot honor an option throws rather than rerouting.

**A credential is named for a provider, never for the request.** `credential_keys` maps
provider name → credential-store key, and the key sent is the one named for the provider that
runs, so a key issued for one vendor cannot reach another; routing prefers a provider a key is
named for, since naming one states which vendors the caller holds a key for. The single
`credential_key` port stays for a pinned provider, where the vendor is unambiguous, and is
refused with `"auto"` — routing picks the vendor at run time, so an unnamed key would go
wherever it landed. `scanGraphForCredentials` reads the map through its `additionalProperties`
value schema, which is what still unlocks the store for the run.

Seven providers ship: `brave`, `tavily`, `searxng` here; `anthropic`, `openai`, `openrouter`,
`gemini` as a `./web-search` subpath on their vendor package, registered explicitly
(`registerAnthropicWebSearchProvider()` and friends) rather than on import. **No provider
auto-registers, the three built-ins included**: `node.ts` registers the task class and
nothing else, and the host states which providers exist by calling
`registerBuiltInWebSearchProviders()` or `registerWebSearchProvider()`. Registering on
import would put Brave in front of `"auto"` routing in an app that only imported
`@workglow/anthropic/web-search`, and stand a SearXNG instance up from an environment
variable nobody read.

HTTP adapters (Brave, Tavily, SearXNG) execute by **owning a `FetchUrlTask`**, inheriting
credential resolution via `credential_key`, SafeFetch's redirect/SSRF checks, retry/backoff,
per-attempt timeouts and the response cache. They do **not** inherit the queue's rate limiter:
`FetchUrlTask` refuses `credential_key` on the queued path (a queued payload is persisted,
secret included), so every keyed provider runs inline, and bounding a `MapTask` fan-out against
a metered quota is the caller's job. The grounded adapters live in their vendor packages and
use the vendor SDK, which is what keeps this package free of any dependency on `@workglow/ai`.
Each hands `context.signal` to the SDK call, not just to a `throwIfAborted()` before it —
otherwise an aborted run leaves a grounded turn in flight and pays for it.

Two Anthropic-specific traps the adapter handles: a `web_search_tool_result` block carries a
**list** on success and an error **object** on failure — at HTTP 200, raising nothing — so
reading it unbranched records a quota failure as a search that found nothing; and a
server-tool turn can stop with `stop_reason: "pause_turn"`, which must be resumed by pushing
the paused assistant content back or the answer is silently truncated.

Port-crossing types (`SearchResult`, `WebSearchUsage`, `WebSearchTaskOutput`) are `type`
aliases, not interfaces: TypeScript gives an alias an implicit index signature and an interface
none, so the interface form is not assignable to the `DataPorts` constraint `Task` imposes.

Only SearXNG needs no API key and has no quota, so it is the only one whose integration test
runs unmocked (`.integration.test.ts`, skipped unless `WEB_SEARCH_SEARXNG_URL` is set).

### `providers/*`

Standalone packages with optional peer deps, each exposing `./ai` (main thread) and
`./ai-runtime` (worker/inline): anthropic, openai, google-gemini, ollama,
huggingface-transformers, huggingface-inference, node-llama-cpp, tf-mediapipe, chrome-ai.
Shared cloud helpers live in `@workglow/ai/provider-utils`.

**`*_JobRunFns.ts` runs inside a worker** with its own `globalServiceRegistry`. Never read
main-thread state (credential stores, service registries) there — resolve it in the task
class (e.g. `AiTask.getJobInput()`) and pass it through the serialized job input.

Rules for writing a run-fn:

- **Never accumulate output.** A provider stream function (`AiProviderStreamFn`) yields
  `text-delta` / `object-delta` events and a `finish` carrying `{} as Output`. `StreamingAiTask` / `TaskRunner` does the accumulating. Do not
  "helpfully" put accumulated data on the finish event.
- **One-shot run-fns are the exception** — meta-ops (`provider.model-info`,
  `provider.model-search`, `model.count-tokens`, `model.unload`, `model.download`),
  embeddings (`text.embedding`, `image.embedding`), and one-shot vision/classification
  (`image.classification`, `image.segmentation`, …) emit a single `finish` whose `data` IS
  the full `Output`, and no deltas. `collectStream` (`@workglow/ai/capability`) returns
  `finish.data` directly in this mode and rejects a stream that mixes the two.
- **Structured generation is the other exception** — run-fns serving
  `["text.generation", "json-mode"]` must populate `finish.data.object`, since
  `StructuredGenerationTask` re-validates one definitive object and drives its retry loop
  from it. Build it with `createPartialJsonStream()` (`@workglow/util/worker`, or
  `/schema` off-worker) rather than re-parsing a growing buffer (O(n²), blocks the
  worker). Use `finishObject()`, not `finish()` — `finish()` is typed `JsonValue` and
  honestly returns an array or scalar root, which the task cannot use. See that module's
  JSDoc for `skipPreamble` (last-complete-wins) and the live-root aliasing contract;
  one-shot repair of an already-accumulated buffer stays on `parsePartialJson`.
- **Report usage, don't narrate it.** Emit `usage` events carrying a **cumulative**
  `Usage` snapshot — the same channel cloud providers use, so local runs surface counts
  with no special case. Never put token counts in a `phase` message: prose is invisible
  to cost math and renders twice. Reserve `phase` for the stage label (`Prefilling`).
  Helpers: `createDecodeUsageReporter` (`HFT_Streaming.ts`, wired into `createStreamingTextStreamer`)
  and `createEstimatedOutputUsageReporter` (`provider-utils/UsageMapping.ts`) for
  OpenAI-compatible APIs that only bill on the final chunk. Provisional estimates are for
  the progress counter only — `finish.usage` supersedes them for cost math.
- **Deltas do not drive progress.** `StreamProcessor` translates only `phase` events into
  `updateProgress`, and `StreamingAiTask` emits one `Generating` phase latched on the
  first delta — so a run-fn that says nothing renders as one static line.
- **Capability collision:** task types sharing a `requires` set (e.g. `AiChatTask` and
  `TextGenerationTask` on `["text.generation"]`) share one registered run-fn, which MUST
  discriminate on a field one caller always sends and the other never does (e.g.
  `Array.isArray(input.messages) && input.messages.length > 0`).

### `examples/cli` — the CLI and its web console

`workglow web` (`src/web/`, client in `src/web/client/`) serves the same commands the
terminal runs. Three load-bearing properties:

- **A run is a child process of the same binary**, given fd 3 for an NDJSON event stream
  and fd 4 for prompt answers. The reporting branch lives in `withCli` — the seam every
  command already runs graphs through — which is why the console works for commands
  nobody wrote it for.
- **Pure presentation lives in `src/ui/model/`** and imports no renderer, so Ink rows and
  browser rows cannot disagree. A test there fails if anything imports ink or react. Two
  models there decide what a run looks like as a whole. `runCensus` walks the whole tree —
  owned subgraphs and live Map clones, not just the graph's top level — into a ledger that
  only ever grows, which is what lets the footer say `184 / 460 tasks` on a three-task
  graph and not walk backwards when an iteration retires; a node still PENDING while its
  own children run is an ownership wrapper (`context.own(new Workflow())`) and is counted
  as scaffolding rather than as a task that can never land. `runViewport` turns that tree
  into one plan of per-list caps, shrinking the **deepest** list first so a Map's own row
  survives to explain the detail beneath it, and the region drawing them holds a
  high-water height: it grows with its content, never shrinks on its own, and is capped by
  the window — a footer that slides up the screen whenever a list gets shorter is a footer
  nobody can read. What still overflows is tail-pinned behind a one-column gutter, which
  costs no rows at exactly the moment rows ran out. `adoptPolledProgress` is the third:
  `Task.progress` initialises to `0` and the runner re-stamps `0` at start, neither
  announced and neither a measurement — the graph needs a number in the denominator of
  its average — so a row (and `runAggregateProgress` for the run's own bar) takes a zero
  only once something has actually reported or landed, and is indeterminate until then.
  Drawn as a determinate zero it reads "0% and stuck", which is what every task that
  reports no progress of its own showed above a subtree visibly moving.
- **Extensions cross the seam as data, never code**: `registerWebPanel`,
  `registerWebFieldWidget`, `registerWebStatusWidget`, `registerCommandSchemaProvider`,
  `registerCommandFieldAnnotations`, `registerCommandAnnotation`. No client bundle to
  ship, no plugin loader. Annotation patterns match a command path (`"*"` = one segment,
  trailing `"**"` = the rest); the more literal pattern wins per key. A field widget's
  `search` receives the rest of the form (`WebFieldWidgetContext`), which is what makes a
  scoped picker possible. A command annotation also states what an `all`-style command
  **runs** — its siblings, in order — and `annotateCommandTree` stamps both sides of that
  from the one declaration: each member's step, and the siblings the `all` leaves out,
  since `all` is a name that routinely covers less than the group it sits in.
  `PanelData` covers `table` (with per-row tones), `kv`, `stats`,
  `timeline`, `markdown`, `empty` and `error`; a status widget contributes meters **or** text
  lines, since most of what an operator checks has no denominator to draw a bar against.

`workglow agent chat` is the terminal consumer of `AgentTask`: a line-based REPL that
streams the model's reply straight to stdout — so the transcript stays in scrollback, which
the Ink run UI's clear-on-complete would erase — prints one row per tool call off the task's
own progress messages, and carries `messages` from one turn's output into the next's input.
`--tools` takes task type names and **has no default**: what an agent may call decides what it
can reach. Approvals go through `PromptHumanConnector`, the connector for anything prompting
BETWEEN runs rather than during one: `InkHumanConnector` needs a mounted
`HumanInteractionHost` and throws without one, while this draws its own prompt and gives the
screen back. It has no `followUp` — a modal prompt settles the question it asked — and
decides form-vs-approval through the same `humanPromptModel` the Ink panel and the console
read.

**The same command serves the web console**, because a chat needs no channel the console did
not already have: each turn runs through `withCli` so its rows and text report up the event
stream, and the next message is asked for as an ordinary `elicit` whose field carries
`format: "chat-message"` — the marker the console keys on to draw a composer instead of a
one-line field, and to fold the answer into a transcript instead of a form somebody once
filled in. A reported session does NOT install `PromptHumanConnector`: the channel installs
its own connector, and overriding it would point a console session's approvals at an Ink
prompt on a process whose stdout is a pipe. `chatTranscript` (`web/client/state.ts`) zips
what the console sent against the `AgentTask` rows it saw, one turn per message, so the
conversation is derived rather than a second copy of the run.

`workglow mcp serve` is the second server the CLI hosts: the registered tasks offered to
MCP clients as tools, one per task type, named for the registered type itself (`task list`
prints the same types with the `Task` suffix trimmed) and carrying the
task's own input schema. It **requires a bearer token by default** — generated per process
and printed with a ready-made client config, pinnable through `WORKGLOW_MCP_TOKEN` or
`--token` for a config that must survive a restart, and droppable only by saying `--no-auth`
out loud. Loopback by default for the same reason the console is.

A task that asks a person asks the MCP client, not the terminal: each tool call runs
against a child registry carrying an `McpElicitationConnector` bound to that call. Bound
per call rather than per process because the connector answers on one call's stream —
and because `relatedRequestId` is what puts the elicitation on that stream at all. Without
it the request rides the session's standalone SSE stream, which the spec leaves optional,
and a client that never opened one has it dropped silently while the task waits forever.
`elicitation.test.ts` pins this with a hand-rolled client, since the SDK's opens that
stream eagerly and so cannot tell the two apart.

**The parts of it worth sharing are not here.** `@workglow/mcp/server` holds them, because
builder and embarc want the same server without the CLI around it: `createTaskMcpServer`
(the tool surface, over any transport), `startMcpHttpServer` (`node:http`),
`McpSessionRouter` (the Streamable HTTP session map, for a host that already has a web
framework) and `authorizeBearer`. The token property above is the CLI's own only in how it
generates one: `startMcpHttpServer` requires `token`, and a host serving unauthenticated
has to write `null` — refused outright on a wildcard bind, where nothing else decides who
may run a task. It is built on the SDK's low-level `Server` rather than
`McpServer` because tasks describe themselves in JSON Schema and `registerTool` takes only
Zod — going through it would mean converting a schema to Zod and back to publish it.

**A downstream CLI reuses this, it does not copy it.** `runWorkglowCli()`
(`src/bootstrap.ts`, exported from `lib.ts`) is the entire body of the `workglow` binary
behind `registerTasks` / `registerCommands` hooks — `workglow.ts` is just a call to it, and
`@workglow/sec`'s `sec-base` is a second caller. Keeping the body here is also what keeps the HuggingFace worker
resolvable — its URL is relative to that module.

The client bundles via `bun run build-web` into `dist/web` and is part of `build-example`. Its webfont link is
deliberately non-render-blocking; a blocking font link blanks the console on any machine
that cannot reach the CDN.

### `@workglow/util`

`EventEmitter`, `ServiceRegistry` (DI), `DirectedAcyclicGraph`, `DataPortSchema`/`JsonSchema`,
`SchemaUtils`/`SchemaValidation`, `uuid4`, `sleep`, `WorkerManager`/`WorkerServer`, vector
math, tensor types.

`WorkerManager` is written against the web `Worker` interface, and `Worker.node.ts` presents
`node:worker_threads` through it. Two mismatches there are silent rather than loud, so leave
the adaptation in place: `worker_threads` rejects a **stringified** `file://` URL
(`ERR_WORKER_PATH`) while every call site passes `new URL(…, import.meta.url)`, and its
`Worker` is an `EventEmitter`, so a `message` listener gets the deserialized value where
`WorkerManager` reads `event.data`. A Node worker thread also has no global `postMessage` —
only `parentPort` — which is why `WorkerServerBase` takes its sender as a `post` option
rather than reaching for the global. `lib: ["dom"]` in the root tsconfig means none of the
three typecheck as errors; `WorkerManager.roundtrip.test.ts` covers them over a real thread,
under both runners.

### `@workglow/tasks`

`InputTask`, `OutputTask`, `LambdaTask`, `DelayTask`, `FetchUrlTask`, `JavaScriptTask`,
`JsonTask`, `MergeTask`, `SplitTask`, `ArrayTask`, MCP tasks, scalar/vector math.
Register with `registerCommonTasks({ fileSystemTasks })` — the flag is required, and decides whether `FileGrepTask`/`FileLoaderTask`/`FileSedTask` are resolvable by type name (and so nameable by graph JSON the host did not author).

## Testing

Tests live mostly in `packages/test/src/test/`; both `bun test` and `vitest` run.
Import from `vitest`. Generic suites are extracted to shared helpers
(e.g. `runGenericJobQueueTests`) and called per backend; gate with
`describe.skipIf(!RUN_QUEUE_TESTS)`.

```sh
bun scripts/test.ts [--all] [kinds...] [sections...] [runners...] [options]
bun scripts/test.ts --changed [base]    # packages affected since base (default origin/main)
```

Sections are **discovered**, never enumerated; `--check-sections` fails if any test file
is unreachable by section+kind selection. Note `packages/test/src/test/task-graph*/` is
section `graph` — `task-graph` selects that package's co-located `__tests__`.
`--changed` delegates package selection to Turbo, so dependents run too.

**Running the same files under Bun** — `bun test` resolves `import { vi } from "vitest"` to
its own compatibility shim, which is missing `setSystemTime`, `stubGlobal`/`stubEnv` and
their `unstubAll*` pairs, and the async timer variants. `scripts/lib/preload-vitest-compat.ts`
(wired in through `bunfig.toml`'s `[test].preload`) installs those on the shim's shared `vi`
object, each guarded so a Bun release that ships its own wins. Two Bun timer quirks are
baked into it: `advanceTimersByTime(0)` still advances a whole millisecond, so a "flush"
spelled that way fires a timer due at `t` while the test believes it stands at `t - 1`; and
a synchronous advance drains the microtask queue before returning, which Vitest's does not.

`runnerFor()` in `scripts/lib/testDiscovery.ts` tags a file `bun` (imports `bun:test`) or
`vitest` (declares a `@vitest-environment`, or calls into Vitest's module registry —
`vi.mock` and friends), and the runner drops each from the other's selection. Bun has no
test environments, and it runs `mock.module` where it is written rather than hoisted, so an
unhoisted mock silently does nothing while the module under test already holds the real
dependency. `testDiscovery.test.ts` fails on a file that matches either signal and is not
tagged. A case that genuinely cannot be expressed on one engine — JavaScriptCore caps regex
backtracking where V8 runs away, Bun swaps `undici` for an `Agent` with no `close` — gets a
named, documented `skipIf` rather than a rewrite.

**Vitest projects** — the root `vitest.config.ts` derives one project per workspace from
the same discovery the runner uses. Anything path-shaped in shared project options must be
**absolute**; a relative `setupFiles` or `typecheck.tsconfig` resolves against each
package root and silently fails to load. `testDiscovery.test.ts` fails if a discovered
test file falls outside every project root — such a file does not error, it just stops
running.

**Coverage** — vitest resolves every `@workglow/*` specifier to the package's `src`
(`scripts/lib/workspaceSource.ts`), so a cross-package suite covers `packages/ai/src/**`
and not `packages/ai/dist/node.js`. Resolution still goes through `exports`, so `dist`
still has to exist: build, or `use-source`, first. Only the nightly workflow collects
coverage (`WORKGLOW_COVERAGE=1`, unit + integration in one job, minus the sections that
download models or call live APIs); `WORKGLOW_TEST_TARGET=dist` turns the rewrite off to
exercise the bundles instead, and refuses coverage there. The include/exclude globs are
repo-root-relative, so coverage and `--project` cannot be combined.

## Developing without building

`bun run use-source` makes every package resolve to its source. It does **not** touch
`package.json`: `exports` keeps pointing at `./dist/*` and the script writes re-export
stubs into each gitignored `dist` folder (`dist/node.js` becomes
`export * from "../src/node.ts"`, `dist/node.d.ts` the declaration equivalent), so
`git status` stays clean and there is nothing
to revert before committing.

`bun run use-dist` removes the stubs (found by a `@workglow-source-stub` sentinel, so real
build output is never deleted) and rebuilds; `--no-build` skips the rebuild.
`publish-workspaces.ts` refuses any workspace still containing stubs.

`bun run link-all` / `unlink-all` register every workspace for `bun link` consumers (sec,
embarc-data, builder). The full libs → sec → embarc-data chain is driven from embarc-data:
run `bun run dev-link` there, or `bun ./dev-link.ts` from the parent `workglow/` folder.
