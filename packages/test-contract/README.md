# `@workglow/test-contract`

Parameterized test suites that exercise an interface contract against
every adapter that implements it. Each suite exports one function:

    export function runXxxConformance(opts: { factory, capabilities, ... }): void;

An adapter writes a thin caller that supplies a factory and capability flags;
all behavioral assertions are inherited.

    import { runTabularStorageContract } from "@workglow/test-contract/tabular-storage";

    runTabularStorageContract({
      name: "MyTabularStorage",
      createStorage: async () => new MyTabularStorage(CompoundSchema, CompoundPrimaryKeyNames),
      capabilities: { supportsSubscriptions: false, supportsVectorColumns: false,
                      supportsTransactions: true, supportsQuery: true },
    });

## Why a separate package

An adapter that implements one of these interfaces is usually not in this
repository. `@workglow/test` — the 441 concrete tests — is `private: true` and
404s on npm, so while the suites lived inside it, every implementation
downstream inherited exactly zero assertions and re-derived the contract by
hand. This package is the suites and nothing else, published so they can be
taken.

Its dependency surface is deliberately small, and split one subpath per
contract: a tabular-storage adapter installs `@workglow/storage` and `vitest`,
and never loads `@workglow/ai` or `@workglow/browser-control` — those are
optional peers that only the suites needing them pull in.

Concrete test files (`*.test.ts`) stay in `packages/test/src/test/`. The
boundary is what makes the pattern obvious: everything here is reusable and
nothing here runs on its own.

The two pre-existing parameterized suites are here as well, though their
signatures predate the `opts` convention below — `runGenericTabularStorageTests`
takes up to three storage factories positionally, `runGenericJobQueueTests` a
storage factory, an optional limiter factory and an options bag. They were
left where their concrete callers were on the first split, on the grounds that
moving them was churn; what that cost was the CRUD half of `ITabularStorage`.
An adapter installing `@workglow/test-contract/tabular-storage` inherited
transactions, criteria and join, and nothing at all about `put`, `get`,
`delete`, `query`, `putBulk` ordering, composite-key separators,
`undefined`-criterion semantics or `updateWhere` CAS — rules with no compiler
behind them, and the ones a `ReadOnlyTabularStorage` wrapper or a scoped
storage is most likely to get subtly wrong.

`packages/test/src/test/{storage-tabular,job-queue}/generic*Tests.ts` are
re-export shims, so the concrete callers there are unchanged.

## Conventions

1.  **Entrypoint shape.**

        export function runXxxConformance(opts: {
          readonly name: string;
          readonly skip?: boolean;
          readonly timeout: number;
          readonly factory: () => Promise<{ register, dispose, inspect }>;
          readonly capabilities: Record<string, boolean>;
          // ...contract-specific fields
        }): void;

    Defines a single top-level `describe.skipIf(opts.skip)`.

2.  **Factory shape.** `factory()` returns a fresh handle per top-level
    `beforeAll`. The handle exposes:
    - `register()` — install the provider/storage/queue and any model records.
    - `dispose()` — release resources; called in `afterAll`.
    - `inspect()` — optional whitebox handle for assertions that need to
      observe internal state (session maps, disposable refs). Adapters that
      don't expose internals return `{}`; assertions skip with a logged
      warning instead of passing silently.

3.  **Capability flags drive `describe.skipIf(!cap)` blocks.** Never silently
    skip on missing capability without a flag — the absence of a flag
    indicates a contract gap, not a permitted variation.

4.  **Live-API tests honor existing preload + retry/timeout settings.** Do
    not introduce new env vars from a contract suite.

5.  **Adapter shims are short.** A new adapter joining a contract suite
    should be ~30 lines: imports, factory, capability flags, model IDs.

6.  **`dispose()` must be idempotent.** Conformance suites may call dispose
    multiple times (once for the dispose assertion, once in `afterAll`).
    Adapters whose underlying resource doesn't natively support repeated
    dispose should guard with a flag.

### Factory shape variants

The `register/dispose/inspect` factory documented above is one of two
legitimate shapes — used when an adapter is a long-lived global registration
(e.g. an AI provider). For contracts whose subject is heavyweight but
per-test state (e.g. browser contexts), prefer a `create/dispose` factory
where each top-level block instantiates its own subject:

    factory: () => Promise<{
      create: () => Promise<TSubject>;
      dispose: (subject: TSubject) => Promise<void>;
    }>

The principle is the same: a fresh handle per block, with no shared state
that block N can leak into block N+1. The methods on the handle are
contract-specific.

## Worker-proxy pattern

Workers cross a `postMessage` boundary; the inline AiProvider conformance
assertions must also hold when a provider is registered via
`register({ worker })`. Each worker-capable adapter's shim invokes the suite
**three times**:

1. `runAiProviderConformance({ name: "<Adapter> (inline)", factory: inlineFactory, ... })`
2. `runAiProviderConformance({ name: "<Adapter> (worker)", factory: workerFactory, ... })`
3. `runWorkerProxyBoundary({ name: "<Adapter>", factory: workerFactory, ... })`

The worker factory's `inspect()` returns `{}` — workers are opaque by
design. The inherited session-reuse and dispose blocks skip with their
existing logged-warning behavior; the boundary block adds three
worker-only assertions (dispose terminates worker, worker-side throw
surfaces with stack, postMessage handles concurrent streams independently).

Capability flags:

- `browserOnly: true` — entire boundary block emits a single skipped test.
  Used for TF-MediaPipe until browser test infra arrives.
- `errorPropagation: false` — relaxes the throw-surfaces assertion to skip
  the stack-frame check, asserting only a non-empty message.

## Available suites

| Contract                                | Suite                                         | Adapters                                                                                              |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AiProvider`                            | `@workglow/test-contract/ai-provider`         | Anthropic, OpenAI, Gemini, Ollama, HF Inference, HF Transformers, LlamaCpp                            |
| `AiProvider` tool turn (mocked)         | `@workglow/test-contract/ai-provider`         | Anthropic, OpenAI, OpenRouter, Gemini 3, Gemini 2.5, Ollama, HF Transformers, llama.cpp server        |
| `IMigrationRunner`                      | `@workglow/test-contract/storage-migrations`  | Postgres, SQLite, IndexedDB                                                                           |
| Tabular schema migrations               | `@workglow/test-contract/tabular-migrations`  | InMemory, IndexedDB, Postgres, SQLite, FsFolder                                                       |
| `ITabularStorage`                       | `@workglow/test-contract/tabular-storage`     | InMemory, SharedInMemory, IndexedDB, Postgres, SQLite, DuckDB, Supabase, Cached, Telemetry, FsFolder  |
| `ITabularStorage.join`                  | `@workglow/test-contract/tabular-storage`     | InMemory, SharedInMemory, IndexedDB, Postgres, SQLite, DuckDB, Supabase, Cached, Telemetry, HttpProxy |
| `ITabularStorage` (rest of the surface) | `@workglow/test-contract/tabular-storage`     | InMemory, IndexedDB, Postgres, SQLite, Supabase, FsFolder, HuggingFace                                |
| `IQueueStorage` + `IRateLimiterStorage` | `@workglow/test-contract/job-queue`           | InMemory, IndexedDB, Postgres, SQLite, Supabase                                                       |
| `IVectorStorage`                        | `@workglow/test-contract/vector-storage`      | InMemory, SQLite, Postgres, IndexedDB, Scoped, Telemetry                                              |
| `IEntitlementProfile`                   | `@workglow/test-contract/entitlement-profile` | Browser, Desktop, Server, Custom                                                                      |
| `IBrowserContext`                       | `@workglow/test-contract/browser-context`     | Mock, Playwright, BunWebView, Electron                                                                |
| `IHumanConnector`                       | `@workglow/test-contract/human-connector`     | Mock, Mock (no followUp), McpElicitation, Prompt, Ink, RunEvent                                       |
| `IWebSearchProvider`                    | `@workglow/test-contract/web-search`          | Brave, Tavily, SearXNG, Anthropic, OpenAI, OpenRouter, Gemini                                         |
| Worker-proxy parity                     | `@workglow/test-contract/worker-proxy`        | _harness only — no adapters wired yet_                                                                |

## Tool-turn round trip: `runToolTurnConformance`

`runAiProviderConformance` drives a live model and is skipped without a key.
What a tool-calling run-fn owes the conversation around it — where a round's
thinking goes, how it reaches the next round, how a tool's result goes back on
the wire — is not something a live model breaks visibly, so it is asserted
here against the provider's own transport answering from a script, and runs
on every build.

A provider's shim supplies a **harness**, built fresh per test:

    runToolTurnConformance({
      name: "Anthropic",
      createHarness: () => ({
        respond: (reply) => ...,        // queue a ScriptedReply, written as the vendor streams it
        run: (request, emit) => ...,    // call the tool-calling run-fn with the shim's model
        sent: () => ...,                // every request body sent, as the vendor received it
        dispose: () => ...,
      }),
      turns: (request) => ...,          // split a request into WireTurns: system | user | assistant | tool
      reasoningStream: "reasoning-port",
      reasoningReplay: { kind: "native", vendor: "anthropic", model: "...", wireForm: JSON.parse },
      toolResultImages: { kind: "in-result" },
    });

A `ScriptedReply` is vendor-neutral (`reasoning`, `text`, `toolCalls`); the
harness writes it as its vendor's stream, signatures and encrypted content
included, so the run-fn reads what the real API would send. The suite never
names a vendor field: it finds the fixture's marker strings in the captured
request, and compares requests with each other — a turn the host changed must
be sent exactly as the same turn with no native payload kept, which holds for
every vendor without the suite knowing what a rebuilt turn looks like.

| Block                     | Rule                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reasoningPortBlock`      | Thinking goes on the `reasoning` port only, never on `text` — also when the provider forwards it nowhere.                                                                                                                                                                            |
| `nativeTurnBlock`         | A `native` provider emits one `nativeTurn` per round, keyed `<vendor>:<model>`, before `finish`; any other provider emits none.                                                                                                                                                      |
| `reasoningRoundTripBlock` | `native`: an unchanged turn carries `wireForm(payload)` verbatim; one whose call id, name or input changed, whose call was dropped, or that another model produced is rebuilt. `text`: the reasoning comes back on the assistant turn. `call-signature`: each call's signature does. |
| `toolResultImageBlock`    | A tool's image goes where `toolResultImages` says: `in-result`, `user-turn-after` (the result itself text-only), or nowhere for `text-only`.                                                                                                                                         |
| `emptyToolResultBlock`    | A tool that returned nothing still answers its call, by id or by name.                                                                                                                                                                                                               |

Every provider states each declaration, so an opt-out is a reason written
down rather than a field left out. Which provider replays what:

| Provider         | `reasoningStream`                     | `reasoningReplay`                                          | `toolResultImages` |
| ---------------- | ------------------------------------- | ---------------------------------------------------------- | ------------------ |
| Anthropic        | reasoning port                        | `native` (`anthropic:<model>`, content blocks)             | `in-result`        |
| OpenAI           | not forwarded (summaries are ignored) | `native` (`openai:<model>`, Responses output items)        | `user-turn-after`  |
| OpenRouter       | reasoning port                        | `native` (`openrouter:<model>`, `reasoning_details`)       | `user-turn-after`  |
| Gemini 3+        | reasoning port                        | `call-signature` (`thoughtSignature`)                      | `in-result`        |
| Gemini 2.5       | reasoning port                        | `call-signature` (`thoughtSignature`)                      | `user-turn-after`  |
| Ollama           | reasoning port                        | `text` (`thinking`)                                        | `user-turn-after`  |
| HF Transformers  | reasoning port                        | `text` (`reasoning_content`)                               | `text-only`        |
| llama.cpp server | reasoning port                        | `text` (`reasoning_content`)                               | `user-turn-after`  |
| DeepSeek         | reasoning port                        | `text` (`reasoning_content`)                               | `user-turn-after`  |
| xAI              | reasoning port                        | `none` (chat completions read no reasoning back)           | `user-turn-after`  |
| HF Inference     | reasoning port                        | `none` (the routed backend may refuse `reasoning_content`) | `user-turn-after`  |
| node-llama-cpp   | reasoning port                        | `text` (ended `thought` segments)                          | `text-only`        |
| Cactus           | reasoning port (`<think>`)            | `none` (one stateless query per round)                     | `text-only`        |
| Chrome AI        | not forwarded (no reasoning channel)  | `none` (no reasoning returned)                             | `text-only`        |

Cactus and Chrome AI have no frame for a call or its result, so the tool
exchange rides in the prompt as prose. Their shims read the turns off the
`Tool call:` / `Tool result from` labels the run-fn writes
(`proseToolExchangeWire.ts`) — the labels the model reads them off — so a
result the prompt does not attribute to its call is not a tool turn there
either.

The shims are `packages/test/src/test/ai-provider*/*_ToolTurn.test.ts`; a
provider's own test file keeps only what is specific to it (the payload's
exact encoding, its retry on a rejected signature, its labels).

## Billing failures: skipped on CI, failed locally

Live provider suites run against real accounts, so "we ran out of money" is a
condition every one of them can hit. `@workglow/test-contract/credit-exhausted-skip` detects
it — 402s, `insufficient_quota`, `insufficient_credits`, DeepSeek's
`Insufficient Balance`, Anthropic's credit-balance error — and the `it` exported
from that module (which every conformance assertion imports) decides what to do
with it:

| where         | behavior | why                                                                                                                                            |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CI            | skip     | nobody watching a build can top an account up, and one exhausted key would turn every provider suite red for a change that touched no provider |
| anywhere else | fail     | the developer running the suite IS the person who can act on it                                                                                |

`CI` / `GITHUB_ACTIONS` select the branch; `WORKGLOW_CREDIT_EXHAUSTED_SKIP=1`
forces the skip locally and `=0` forces the failure on CI.

The detector reads the **message** as well as the numeric status, and that is
load-bearing rather than belt-and-braces: `classifyProviderError` rebuilds a
provider error as a `PermanentJobError` carrying the message and neither
`status` nor `cause`, so by the time a test body catches a DeepSeek 402 the
number survives only as the `402 Insufficient Balance` text the OpenAI SDK put
in the message. A status-only detector reads that as an ordinary permanent
failure — which is exactly how DeepSeek kept failing suites while every other
provider skipped. Message matching for a bare `402` is anchored to an
HTTP-shaped position (line start, or after a summary line's colon) so prose
that merely contains the number is not scavenged as a status.

Rate limits (429 + `rate_limit_exceeded`) are deliberately NOT this: they are
transient and the retry policy handles them.

## How to add a new contract suite

1. Pick a contract surface (an interface or abstract base class).
2. Enumerate the behavioral invariants the contract implies but that aren't
   currently asserted in any concrete test.
3. Decide the capability matrix — which assertions are universal, which
   are opt-in.
4. Create `packages/test-contract/src/<contract-name>/` with `types.ts`,
   `fixtures.ts`, `run<Contract>Conformance.ts`, and per-assertion files
   under `assertions/`.
5. Add `src/<contract-name>.ts` re-exporting all of it, and an
   `exports["./<contract-name>"]` entry plus a `build-js` entrypoint in
   `package.json` — a suite nobody can import is the problem this package
   exists to fix.
6. Write one shim caller per adapter under
   `packages/test/src/test/<contract-name>/<Adapter>_Generic.integration.test.ts`.
7. Add a row to the table above.

## Two strategies, one contract

`runTabularJoinContract` is the one suite here whose subject has two
implementations of a single semantics — a pushed-down `JOIN` statement when
both tables share a connection, an application-side hash join otherwise — with
the planner, not the caller, choosing between them. That makes a disagreement
between them a wrong answer nothing reports, which changes with where the
right-hand storage happens to live.

So it runs three blocks rather than one. The behavioural cases run on whichever
path the pair takes. `join bounded left read` runs only on the hash path and
asserts the half of the docstring the pushdown gets from the database for free:
that a bounded join stops reading the left side early, and only when the joined
rows are already in their final order. `join strategy parity` runs only where
both paths are reachable, runs the same spec through each, and asserts they
agree — over specs derived from the fields of `JoinSpec`, so an option added
there fails to compile until it declares what the two strategies owe each
other.

What the two are held to depends on what the spec asked for, because `join`
promises `orderBy`, `limit` and `offset` apply to the joined rows and never what
order an unordered join arrives in. An unordered join is compared as a set; an
unordered join that is also windowed is compared by row count and membership.
Holding either to a shared order would assert the storage engine's row layout,
which SQLite and Postgres happen to share and DuckDB, being columnar, does not.

## Roadmap

Future contract suites in priority order:

1. Storage extensions (subscribeToChanges ordering, vector-dimension format,
   putBulk round-trip count, deleteSearch streaming) — additions to the
   existing `tabular-storage/genericTabularStorageTests.ts`, and normalizing
   that suite and the job-queue one onto the `opts` entrypoint shape the rest
   of the package uses.
2. Worker-proxy contract — harness shipped; per-adapter wiring deferred to a
   follow-up PR (vitest-Node `Worker` polyfill + per-adapter
   `WorkerManager` unregister-on-dispose required before HFT/LlamaCpp can
   register inline + worker in the same test file).
3. `IBrowserContext` — Playwright / Electron / BunWebView / CDP backends.
4. `EntitlementProfile` — desktop / web / server profiles.
5. `IHumanConnector` — IN PROGRESS — `MockHumanConnector` + `McpElicitationConnector`. App / Electron adapters add their own shim when introduced.
