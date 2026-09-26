/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBrowserLike, resolveApiKey, validateProviderBaseUrl } from "@workglow/ai/provider-utils";
import { resolveEnabledEffort, type ModelEffort } from "@workglow/ai/worker";
import { openaiEffortPolicy } from "./OpenAI_EffortPolicy";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

/** Maps coarse {@link ModelEffort} to OpenAI Responses `reasoning.effort`. */
const EFFORT_TO_OPENAI: Record<ModelEffort, string> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  ultra: "max",
};

/**
 * Hostnames (or hostname suffixes) accepted for OpenAI `base_url` without
 * the explicit `trustedBaseUrl` opt-out. Includes Azure OpenAI tenants.
 */
export const OPENAI_ALLOWED_HOSTS: readonly string[] = ["api.openai.com", ".openai.azure.com"];

type OpenAIClientClass = new (config: any) => any;

let _loadPromise: Promise<OpenAIClientClass> | undefined;

// NOTE: we do not want to de-dup this in the provider-utils, vite wants direct import with string literals.
export async function loadOpenAISDK(): Promise<OpenAIClientClass> {
  _loadPromise ??= import(/* @vite-ignore */ "openai")

    .then((mod) => mod.default as OpenAIClientClass)
    .catch(() => {
      _loadPromise = undefined;
      throw new Error("openai is required for OpenAI tasks. Install it with: bun add openai");
    });
  return _loadPromise;
}

interface ResolvedProviderConfig {
  readonly credential_key?: string;
  readonly api_key?: string;
  readonly model_name?: string;
  readonly base_url?: string;
  readonly organization?: string;
  readonly prompt_cache_key?: string;
  readonly reasoning?: { readonly effort?: string; readonly mode?: string };
  /**
   * When `true`, accept the `base_url` even if its hostname is not in
   * {@link OPENAI_ALLOWED_HOSTS}. Use only for known-good custom enterprise
   * gateways. The URL still has to parse and use a safe scheme.
   */
  readonly trustedBaseUrl?: boolean;
}

let _testClient: unknown;

/**
 * Override the client returned by {@link getClient} so runtime tests can
 * capture the requests the OpenAI run-fns build without a live SDK, API key,
 * or network call. Pass `undefined` to restore normal SDK-backed creation.
 * This lives in the runtime module (not a `vi.mock` of `openai`) so it works
 * identically whether the provider resolves to `src` or the bundled `dist`,
 * and is immune to duplicate SDK copies across the workspace defeating
 * module-level mocks.
 */
function setOpenAIClientForTests(client: unknown): void {
  _testClient = client;
}

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. Surfaced on the `ai-runtime` barrel (via `export *`) and
 * merged into the `/ai` barrel's `_testOnly`.
 */
export const _testOnly = {
  setOpenAIClientForTests,
} as const;

export async function getClient(model: OpenAiModelConfig | undefined) {
  if (_testClient) return _testClient as InstanceType<OpenAIClientClass>;
  const OpenAI = await loadOpenAISDK();
  const config = model?.provider_config as ResolvedProviderConfig | undefined;
  const apiKey = resolveApiKey({
    config,
    envVar: "OPENAI_API_KEY",
    providerLabel: "OpenAI",
  });
  // Throw before SDK construction on a rejected base_url so the API key is
  // never sent to an unvalidated host.
  const baseURL = validateProviderBaseUrl(config?.base_url, {
    vendor: "openai",
    allowHosts: OPENAI_ALLOWED_HOSTS,
    trustedBaseUrl: config?.trustedBaseUrl,
    providerLabel: "OpenAI",
  });
  try {
    return new OpenAI({
      apiKey,
      baseURL,
      organization: config?.organization || undefined,
      dangerouslyAllowBrowser: isBrowserLike(),
    });
  } catch (err) {
    throw new Error(
      `Failed to create OpenAI client: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

export function getModelName(model: OpenAiModelConfig | undefined): string {
  const name = model?.provider_config?.model_name;
  if (!name) {
    throw new Error("Missing model name in provider_config.model_name.");
  }
  return name;
}

/**
 * Resolves the `reasoning` object for reasoning-capable models (GPT-5.6
 * sol/terra/luna and the o-series). Native `provider_config.reasoning` wins;
 * otherwise map `model.effort`. Returns `undefined` when neither is set.
 */
export function getReasoningConfig(
  model: OpenAiModelConfig | undefined
): { effort?: string; mode?: string } | undefined {
  const reasoning = (model?.provider_config as ResolvedProviderConfig | undefined)?.reasoning;
  if (reasoning && (reasoning.effort !== undefined || reasoning.mode !== undefined)) {
    return reasoning;
  }
  const effort = resolveEnabledEffort(model, openaiEffortPolicy(model));
  if (effort !== undefined) return { effort: EFFORT_TO_OPENAI[effort] };
  return undefined;
}

/** Deterministic 32-bit FNV-1a hash → 8-char hex. Worker-safe (no crypto import). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Resolves the Responses `prompt_cache_key`. Uses an explicit
 * `provider_config.prompt_cache_key` override when set, otherwise derives a
 * stable key from the request's cache-relevant prefix (model + system
 * instructions + tools) so requests sharing that prefix converge on one key and
 * hit the cache. GPT-5.6 bills cache writes, so a stable key (not a random one)
 * is the cost-correct default.
 */
export function resolvePromptCacheKey(
  model: OpenAiModelConfig | undefined,
  params: { model?: unknown; instructions?: unknown; tools?: unknown }
): string {
  const override = (model?.provider_config as ResolvedProviderConfig | undefined)?.prompt_cache_key;
  if (override) return override;
  const material = JSON.stringify([
    params.model ?? "",
    params.instructions ?? "",
    params.tools ?? null,
  ]);
  return `wg-${fnv1aHex(material)}`;
}

/**
 * Applies the per-request Responses fields common to every OpenAI text run-fn:
 * the model's `reasoning` config and a stable `prompt_cache_key`. Mutates and
 * returns `params` so callers can inline it into the create call. Call this
 * last, after model/instructions/tools/temperature are populated, so the cache
 * key sees the full prefix and a pinned temperature can be reconciled with it.
 *
 * A reasoning model with no effort configured is sent its class default
 * (`medium`) rather than left to the vendor's, so the effort the UI shows as
 * "Default" is the one that runs — unless the record's `effort_options`
 * leaves that level out. A model that takes no `reasoning` gets no
 * field, which it would 400 on. An explicit `reasoning` in the model config
 * always wins.
 *
 * `temperature` is rejected alongside any reasoning effort but `"none"` —
 * verified live against `gpt-5.6-luna` and `gpt-6-astra` — so it is dropped
 * whenever reasoning is on rather than failing the request. To sample at a
 * pinned temperature, set the effort to `none` on a model that allows it.
 */
export function finalizeResponsesRequest(
  model: OpenAiModelConfig | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  const policy = openaiEffortPolicy(model);
  const fallback = resolveEnabledEffort({ ...model, effort: policy.default }, policy);
  const reasoning =
    getReasoningConfig(model) ??
    (fallback !== undefined ? { effort: EFFORT_TO_OPENAI[fallback] } : undefined);
  if (reasoning !== undefined) {
    params.reasoning = reasoning;
    if (reasoning.effort !== "none") delete params.temperature;
  }
  params.prompt_cache_key = resolvePromptCacheKey(model, params);
  return params;
}
