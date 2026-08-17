/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The browser condition, COMPILED rather than parsed.
 *
 * This is the only place in the repo where a compiler resolves a provider or
 * meta-package subpath under `customConditions: ["browser"]`. Everything else
 * that checks the browser split reads manifests and barrels AS TEXT:
 * `ExportTypesPairing.test.ts` walks `exports` maps, `ExportBarrelParity.test.ts`
 * diffs `export` statements. Both are blind to the failure that actually
 * reaches a consumer — an `export *` dropped from BOTH halves of a pair keeps
 * barrel parity, keeps the manifest self-consistent, builds clean, and shows up
 * only when a downstream browser app upgrades and gets `TS2305`.
 *
 * The file never RUNS. It is type-only, and the assertion is that it RESOLVES
 * and COMPILES.
 *
 * Two kinds of assertion, and the negatives are what make the positives mean
 * anything:
 *
 * - POSITIVE — `typeof Ns.Name` for a symbol each subpath must export. A
 *   dropped re-export fails with `TS2339`.
 * - NEGATIVE — `@ts-expect-error` on a node-only symbol (`_testOnly`). If
 *   `customConditions` silently stopped applying, every positive would still
 *   pass against the NODE declarations and only these would notice: the
 *   expected error would not occur and each becomes `TS2578`.
 *
 * Compiled by `bun run typecheck:browser` (`tsconfig.browser-conditions.json`)
 * and deliberately NEVER by `packages/test`'s own `build-types`, which runs
 * under node conditions where `_testOnly` resolves and every negative control
 * would be a `TS2578` build failure. `packages/test/tsconfig.json` excludes
 * this directory for exactly that reason.
 *
 * The subpath list is not maintained by hand alone: a guard in
 * `ExportTypesPairing.test.ts` derives the expected set from the `providers/*`
 * and `packages/workglow` manifests — EVERY subpath that really splits, with no
 * exemption list — so a new provider that ships a browser split fails until
 * this file names it. `packages/*` is out of scope on purpose: `examples/web`
 * already compiles a slice of it under `customConditions`.
 */

import type * as AwsJobQueue from "@workglow/aws/job-queue";
import type * as Cactus from "@workglow/cactus/ai";
import type * as CactusRuntime from "@workglow/cactus/ai-runtime";
import type * as DeepSeek from "@workglow/deepseek/ai";
import type * as DeepSeekRuntime from "@workglow/deepseek/ai-runtime";
import type * as DuckDbStorage from "@workglow/duckdb/storage";
import type * as Ollama from "@workglow/ollama/ai";
import type * as OllamaRuntime from "@workglow/ollama/ai-runtime";
import type * as OpenAi from "@workglow/openai/ai";
import type * as OpenAiRuntime from "@workglow/openai/ai-runtime";
import type * as OpenRouter from "@workglow/openrouter/ai";
import type * as OpenRouterRuntime from "@workglow/openrouter/ai-runtime";
import type * as PostgresJobQueue from "@workglow/postgres/job-queue";
import type * as PostgresStorage from "@workglow/postgres/storage";
import type * as PostgresText from "@workglow/postgres/text";
import type * as SqliteJobQueue from "@workglow/sqlite/job-queue";
import type * as SqliteStorage from "@workglow/sqlite/storage";
import type * as SupabaseJobQueue from "@workglow/supabase/job-queue";
import type * as SupabaseStorage from "@workglow/supabase/storage";
import type * as Xai from "@workglow/xai/ai";
import type * as XaiRuntime from "@workglow/xai/ai-runtime";
import type * as Workglow from "workglow";
import type * as WorkglowDeepSeek from "workglow/deepseek";
import type * as WorkglowOllama from "workglow/ollama";
import type * as WorkglowOpenAi from "workglow/openai";
import type * as WorkglowOpenRouter from "workglow/openrouter";
import type * as WorkglowWorker from "workglow/worker";
import type * as WorkglowXai from "workglow/xai";

/** A symbol each subpath must still export under the browser condition. */
type Resolved = string;

// --- providers: `./ai` -------------------------------------------------------
export type OpenAiProvider = Resolved & typeof OpenAi.OPENAI;
export type OpenRouterProvider = Resolved & typeof OpenRouter.OPENROUTER;
export type XaiProvider = Resolved & typeof Xai.XAI;
export type OllamaProvider = Resolved & typeof Ollama.OLLAMA;
export type DeepSeekProvider = Resolved & typeof DeepSeek.DEEPSEEK;
export type CactusProvider = Resolved & typeof Cactus.LOCAL_CACTUS;

// --- providers: `./ai-runtime` ----------------------------------------------
export type OpenAiInline = typeof OpenAiRuntime.registerOpenAiInline;
export type OpenRouterInline = typeof OpenRouterRuntime.registerOpenRouterInline;
export type XaiInline = typeof XaiRuntime.registerXaiInline;
export type OllamaInline = typeof OllamaRuntime.registerOllamaInline;
export type DeepSeekInline = typeof DeepSeekRuntime.registerDeepSeekInline;
export type CactusInline = typeof CactusRuntime.registerCactusInline;

// --- storage / job-queue providers, which split on the same convention ------
/**
 * `@workglow/aws/job-queue`'s browser build is a throw-on-load stub exporting
 * nothing (`export {}`), so there is no symbol to name and that it RESOLVES
 * under the browser condition is the whole assertion. Spelled as a `keyof` (so
 * `never`) rather than a bare import, because organize-imports prunes an import
 * nothing references and would silently delete the case.
 */
export type AwsJobQueueSurface = keyof typeof AwsJobQueue;

export type DuckDbTabular = typeof DuckDbStorage.DuckDbTabularStorage;
export type PostgresQueue = typeof PostgresJobQueue.PostgresQueueStorage;
export type PostgresKv = typeof PostgresStorage.PostgresKvStorage;
export type PostgresFts = typeof PostgresText.PostgresFtsTextIndex;
export type SqliteQueue = typeof SqliteJobQueue.SqliteQueueStorage;
export type SqliteKv = typeof SqliteStorage.SqliteKvStorage;
export type SupabaseQueue = typeof SupabaseJobQueue.SupabaseQueueStorage;
export type SupabaseKv = typeof SupabaseStorage.SupabaseKvStorage;

// --- the meta-package -------------------------------------------------------
export type WorkglowTaskRegistry = typeof Workglow.TaskRegistry;
export type WorkglowWorkerRegistry = typeof WorkglowWorker.AiProviderRegistry;

/**
 * The meta-package's vendor shims, which are the two-hop case: `packages/workglow`'s
 * own `tsgo` run compiles `src/openai.browser.ts` under NODE conditions, so the
 * browser path THROUGH the shim is checked nowhere else. Here the emitted
 * `dist/openai.browser.d.ts` is a pass-through that gets re-resolved under
 * `browser` at the provider hop.
 */
export type WorkglowOpenAiProvider = Resolved & typeof WorkglowOpenAi.OPENAI;
export type WorkglowOpenRouterProvider = Resolved & typeof WorkglowOpenRouter.OPENROUTER;
export type WorkglowXaiProvider = Resolved & typeof WorkglowXai.XAI;
export type WorkglowOllamaProvider = Resolved & typeof WorkglowOllama.OLLAMA;
export type WorkglowDeepSeekProvider = Resolved & typeof WorkglowDeepSeek.DEEPSEEK;

/**
 * Negative controls. `_testOnly` is node-only by design (see
 * `INTENTIONAL_NODE_ONLY` in `ExportBarrelParity.test.ts`), so resolving it
 * here would prove the browser condition was never applied.
 *
 * Deliberately NOT asserted for `@workglow/cactus`, which exports `_testOnly`
 * from BOTH barrels.
 */
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type OpenAiTestOnly = typeof OpenAi._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type OpenRouterTestOnly = typeof OpenRouter._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type XaiTestOnly = typeof Xai._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type OllamaTestOnly = typeof Ollama._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type DeepSeekTestOnly = typeof DeepSeek._testOnly;

// The same five through the meta-package's shims, which is the hop that proves
// the shim's `browser` condition is doing real work rather than aliasing node.
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type WorkglowOpenAiTestOnly = typeof WorkglowOpenAi._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type WorkglowOpenRouterTestOnly = typeof WorkglowOpenRouter._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type WorkglowXaiTestOnly = typeof WorkglowXai._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type WorkglowOllamaTestOnly = typeof WorkglowOllama._testOnly;
// @ts-expect-error `_testOnly` is node-only, so the browser condition must not resolve it
export type WorkglowDeepSeekTestOnly = typeof WorkglowDeepSeek._testOnly;
