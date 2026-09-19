/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBrowserLike, resolveApiKey, validateProviderBaseUrl } from "@workglow/ai/provider-utils";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";

/** Default base URL for the TypeSafe API, and the SDK's own default. */
export const TYPESAFEAI_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/**
 * Hostnames (or hostname suffixes) accepted for TypeSafe `base_url` without the
 * explicit `trustedBaseUrl` opt-out.
 */
export const TYPESAFEAI_ALLOWED_HOSTS: readonly string[] = ["api.typesafe.ai"];

/**
 * The alias the vendor documents as the current flagship, used when a search
 * result or a model record names nothing more specific. An alias moves when a
 * release ships, so pin the versioned id (`jev-1.13.0`) on a model whose
 * confidence thresholds have been tuned against that version.
 */
export const TYPESAFEAI_DEFAULT_MODEL_NAME = "jev-latest";

/** Candidates a rerank scores concurrently when the model names no other bound. */
export const TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY = 8;

/** Text, or a JSON object or array, wherever TypeSafe accepts prose or structure. */
export type TypeSafeEntry = string | { [key: string]: unknown } | unknown[];

/** One typed question, as the wire format discriminates them. */
export type TypeSafeQuestion =
  | { type: "noul"; instructions: TypeSafeEntry; criteria?: unknown }
  | { type: "choice"; instructions: TypeSafeEntry; criteria: Record<string, unknown> }
  | { type: "score"; instructions: TypeSafeEntry; criteria: readonly unknown[] };

export interface TypeSafeNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface TypeSafeChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface TypeSafeScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, unknown>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export interface TypeSafeUsagePayload {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

export interface TypeSafeSystemOneResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, TypeSafeAnswer>>;
  readonly usage?: TypeSafeUsagePayload;
}

export interface TypeSafeModelCard {
  readonly name: string;
  readonly description?: string;
  readonly release_date?: string;
}

/**
 * The slice of the SDK client this provider calls.
 *
 * Declared structurally rather than as a `Pick` of the SDK's own class because
 * the SDK returns an `APIPromise`, a `Promise` subclass carrying the raw HTTP
 * response. Nothing here reads that response, and typing against it would make
 * every test double have to be one — a plain `Promise` does not satisfy it. The
 * request and answer shapes are the SDK's, so a wire change still surfaces at
 * the call sites that read them.
 */
export interface TypeSafeClientLike {
  systemOne(
    request: {
      readonly state: TypeSafeEntry;
      readonly questions: Readonly<Record<string, TypeSafeQuestion>>;
      readonly model?: string;
    },
    options?: { readonly signal?: AbortSignal }
  ): Promise<TypeSafeSystemOneResult>;
  readonly models: {
    list(options?: { readonly signal?: AbortSignal }): Promise<readonly TypeSafeModelCard[]>;
  };
}

type TypeSafeClientClass = new (config: Record<string, unknown>) => TypeSafeClientLike;

let _loadPromise: Promise<TypeSafeClientClass> | undefined;

// Keep the direct string-literal import so bundlers (vite) can resolve it
// statically.
export async function loadTypeSafeSDK(): Promise<TypeSafeClientClass> {
  _loadPromise ??= import(/* @vite-ignore */ "@typesafe-ai/sdk")
    .then((mod) => mod.TypeSafeClient as unknown as TypeSafeClientClass)
    .catch(() => {
      _loadPromise = undefined;
      throw new Error(
        "@typesafe-ai/sdk is required for TypeSafe tasks. Install it with: bun add @typesafe-ai/sdk"
      );
    });
  return _loadPromise;
}

interface ResolvedProviderConfig {
  readonly credential_key?: string;
  readonly api_key?: string;
  readonly model_name?: string;
  readonly base_url?: string;
  readonly rerank_concurrency?: number;
  /**
   * When `true`, accept the `base_url` even if its hostname is not in
   * {@link TYPESAFEAI_ALLOWED_HOSTS}. Use only for known-good custom gateways.
   * The URL still has to parse and use a safe scheme.
   */
  readonly trustedBaseUrl?: boolean;
}

let _testClient: TypeSafeClientLike | undefined;

/**
 * Override the client returned by {@link getClient} so runtime tests can
 * exercise run-fns without a live SDK, API key, or network call. Pass
 * `undefined` to restore normal SDK-backed creation.
 */
function setTypeSafeAiClientForTests(client: TypeSafeClientLike | undefined): void {
  _testClient = client;
}

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. Surfaced on the `ai-runtime` barrel (via `export *`) and
 * merged into the `/ai` barrel's `_testOnly`.
 */
export const _testOnly = {
  setTypeSafeAiClientForTests,
} as const;

export async function getClient(
  model: TypeSafeAiModelConfig | undefined
): Promise<TypeSafeClientLike> {
  if (_testClient) return _testClient;
  const TypeSafeClient = await loadTypeSafeSDK();
  const config = model?.provider_config as ResolvedProviderConfig | undefined;
  const apiKey = resolveApiKey({
    config,
    envVar: "TYPESAFE_API_KEY",
    providerLabel: "TypeSafe",
  });
  // Throw before SDK construction on a rejected base_url so the API key is
  // never sent to an unvalidated host.
  const baseURL =
    validateProviderBaseUrl(config?.base_url, {
      vendor: "typesafe",
      allowHosts: TYPESAFEAI_ALLOWED_HOSTS,
      trustedBaseUrl: config?.trustedBaseUrl,
      providerLabel: "TypeSafe",
    }) ?? TYPESAFEAI_DEFAULT_BASE_URL;
  try {
    return new TypeSafeClient({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: isBrowserLike(),
    });
  } catch (err) {
    throw new Error(
      `Failed to create TypeSafe client: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

export function getModelName(model: TypeSafeAiModelConfig | undefined): string {
  const name = model?.provider_config?.model_name;
  if (!name) {
    throw new Error("Missing model name in provider_config.model_name.");
  }
  return name;
}

/**
 * How many candidates a rerank may have in flight at once.
 *
 * Every candidate is scored by its own request — that is what keeps the scores
 * independent — so a 200-document rerank is 200 requests, and an unbounded
 * fan-out walks straight into the account's requests-per-minute limit. A
 * non-positive or non-finite configured value is the caller saying nothing
 * usable, so the default stands rather than a bound of zero stalling the run.
 */
export function resolveRerankConcurrency(model: TypeSafeAiModelConfig | undefined): number {
  const configured = (model?.provider_config as ResolvedProviderConfig | undefined)
    ?.rerank_concurrency;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1) {
    return TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY;
  }
  return Math.floor(configured);
}
