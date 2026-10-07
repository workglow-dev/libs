/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBrowserLike, resolveApiKey, validateProviderBaseUrl } from "@workglow/ai/provider-utils";
import { resolveEnabledEffort, type ModelEffort } from "@workglow/ai/worker";
import { deepseekEffortPolicy } from "./DeepSeek_EffortPolicy";
import type { DeepSeekModelConfig } from "./DeepSeek_ModelSchema";

/** Maps coarse {@link ModelEffort} to DeepSeek reasoning token allowance. */
const EFFORT_TO_REASONING_ALLOWANCE: Record<ModelEffort, number> = {
  none: 0,
  low: 4096,
  medium: 8192,
  high: 16_384,
  extra: 24_576,
  ultra: 32_768,
};

/**
 * Default base URL for the DeepSeek OpenAI-compatible API. DeepSeek serves the
 * same routes with and without a `/v1` prefix; the un-prefixed form is what the
 * vendor documents, and it is what makes `client.models.list()` hit the
 * documented `GET /models` endpoint.
 */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * Hostnames (or hostname suffixes) accepted for DeepSeek `base_url` without the
 * explicit `trustedBaseUrl` opt-out.
 */
export const DEEPSEEK_ALLOWED_HOSTS: readonly string[] = ["api.deepseek.com"];

type OpenAIClientClass = new (config: any) => any;

let _loadPromise: Promise<OpenAIClientClass> | undefined;

// DeepSeek is OpenAI wire-compatible, so we reuse the `openai` SDK. Keep the
// direct string-literal import so bundlers (vite) can resolve it statically.
export async function loadOpenAISDK(): Promise<OpenAIClientClass> {
  _loadPromise ??= import(/* @vite-ignore */ "openai")

    .then((mod) => mod.default as OpenAIClientClass)
    .catch(() => {
      _loadPromise = undefined;
      throw new Error("openai is required for DeepSeek tasks. Install it with: bun add openai");
    });
  return _loadPromise;
}

interface ResolvedProviderConfig {
  readonly credential_key?: string;
  readonly api_key?: string;
  readonly model_name?: string;
  readonly base_url?: string;
  /**
   * When `true`, accept the `base_url` even if its hostname is not in
   * {@link DEEPSEEK_ALLOWED_HOSTS}. Use only for known-good custom gateways.
   * The URL still has to parse and use a safe scheme.
   */
  readonly trustedBaseUrl?: boolean;
}

let _testClient: unknown;

/**
 * Override the client returned by {@link getClient} so runtime tests can
 * exercise run-fns without a live SDK, API key, or network call. Pass
 * `undefined` to restore normal SDK-backed creation.
 */
function setDeepSeekClientForTests(client: unknown): void {
  _testClient = client;
}

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. Surfaced on the `ai-runtime` barrel (via `export *`) and
 * merged into the `/ai` barrel's `_testOnly`.
 */
export const _testOnly = {
  setDeepSeekClientForTests,
} as const;

export async function getClient(model: DeepSeekModelConfig | undefined) {
  if (_testClient) return _testClient as InstanceType<OpenAIClientClass>;
  const OpenAI = await loadOpenAISDK();
  const config = model?.provider_config as ResolvedProviderConfig | undefined;
  const apiKey = resolveApiKey({
    config,
    envVar: "DEEPSEEK_API_KEY",
    providerLabel: "DeepSeek",
  });
  // Throw before SDK construction on a rejected base_url so the API key is
  // never sent to an unvalidated host.
  const baseURL =
    validateProviderBaseUrl(config?.base_url, {
      vendor: "deepseek",
      allowHosts: DEEPSEEK_ALLOWED_HOSTS,
      trustedBaseUrl: config?.trustedBaseUrl,
      providerLabel: "DeepSeek",
    }) ?? DEEPSEEK_DEFAULT_BASE_URL;
  try {
    return new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: isBrowserLike(),
    });
  } catch (err) {
    throw new Error(
      `Failed to create DeepSeek client: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

export function getModelName(model: DeepSeekModelConfig | undefined): string {
  const name = model?.provider_config?.model_name;
  if (!name) {
    throw new Error("Missing model name in provider_config.model_name.");
  }
  return name;
}

/**
 * DeepSeek's names for the shared effort levels. `none` is not a level here:
 * it turns thinking off, which DeepSeek spells as a separate switch.
 */
const EFFORT_TO_REASONING_EFFORT: Record<Exclude<ModelEffort, "none">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  ultra: "max",
};

/**
 * The request fields that carry `model.effort` to DeepSeek. Without them the
 * effort a caller set only sized `max_tokens`, and the model reasoned at its own
 * default whatever was asked. Nothing is sent for a model whose policy has no
 * reasoning, or when no effort is set.
 */
export function reasoningParams(model: DeepSeekModelConfig | undefined): {
  reasoning_effort?: string;
  thinking?: { type: "disabled" };
} {
  const effort = resolveEnabledEffort(model, deepseekEffortPolicy(model));
  if (effort === undefined) return {};
  if (effort === "none") return { thinking: { type: "disabled" } };
  return { reasoning_effort: EFFORT_TO_REASONING_EFFORT[effort] };
}

/**
 * Reasoning headroom added when the model sets no `reasoning_allowance`. Sized
 * above the ~4k reasoning tokens the thinking models typically spend.
 */
export const DEEPSEEK_DEFAULT_REASONING_ALLOWANCE = 16_384;

/**
 * Turns the caller's answer-token budget into DeepSeek's `max_tokens`. Thinking
 * models bill `reasoning_tokens` against the same budget, so the wire value has
 * to cover both. Native `reasoning_allowance` wins over `model.effort`; when
 * neither is set the shared default allowance applies — but only to a model the
 * policy says reasons at all. Both branches read the one policy: paying the
 * default allowance on a model it has just declared has no reasoning spends a
 * whole extra `max_tokens` budget on tokens that are never generated.
 * Undefined budget stays undefined, leaving DeepSeek's default.
 */
export function resolveMaxTokens(
  model: DeepSeekModelConfig | undefined,
  maxTokens: number | undefined
): number | undefined {
  if (maxTokens === undefined) return undefined;
  const configured = model?.provider_config?.reasoning_allowance;
  if (typeof configured === "number") return maxTokens + Math.max(0, configured);
  const policy = deepseekEffortPolicy(model);
  const effort = resolveEnabledEffort(model, policy);
  const allowance =
    effort !== undefined
      ? EFFORT_TO_REASONING_ALLOWANCE[effort]
      : policy.supported.length === 0
        ? 0
        : DEEPSEEK_DEFAULT_REASONING_ALLOWANCE;
  return maxTokens + Math.max(0, allowance);
}

/**
 * Throws when the budget ran out before any content was emitted — otherwise the
 * empty string parses to `{}` and surfaces as a confusing schema error. A
 * truncated-but-non-empty response is left alone; the partial is worth keeping.
 */
export function assertNotTruncatedByReasoning(
  finishReason: string | null | undefined,
  content: string,
  requestedMaxTokens: number | undefined
): void {
  if (finishReason !== "length" || content.length > 0) return;
  const budget =
    requestedMaxTokens === undefined
      ? "the model's default max_tokens"
      : `max_tokens=${requestedMaxTokens} (+ reasoning allowance)`;
  throw new Error(
    `DeepSeek exhausted its token budget on reasoning and returned no content ` +
      `(finish_reason="length", 0 content tokens, ${budget}). Raise the task's ` +
      `maxTokens, or raise provider_config.reasoning_allowance for this model.`
  );
}
