/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isBrowserLike,
  OPENAI_STREAM_USAGE_OPTIONS,
  resolveApiKey,
  validateProviderBaseUrl,
} from "@workglow/ai/provider-utils";
import { resolveEnabledEffort, type ModelEffort } from "@workglow/ai/worker";
import { metaEffortPolicy } from "./Meta_EffortPolicy";
import type { MetaModelConfig } from "./Meta_ModelSchema";

/** Default base URL for the Meta Model API's OpenAI-compatible surface. */
export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1";

/**
 * Hostnames (or hostname suffixes) accepted for Meta `base_url` without the
 * explicit `trustedBaseUrl` opt-out.
 */
export const META_ALLOWED_HOSTS: readonly string[] = ["api.meta.ai"];

/**
 * Environment variables read for the API key, in order. Meta's own docs name
 * `MODEL_API_KEY`; `META_API_KEY` is checked first because that generic name
 * is easy to collide with in an app talking to several providers.
 */
export const META_API_KEY_ENV_VARS: readonly string[] = ["META_API_KEY", "MODEL_API_KEY"];

type OpenAIClientClass = new (config: any) => any;

let _loadPromise: Promise<OpenAIClientClass> | undefined;

// The Meta Model API speaks the OpenAI chat-completions wire format, so we reuse
// the `openai` SDK. Keep the direct string-literal import so bundlers (vite) can
// resolve it statically.
export async function loadOpenAISDK(): Promise<OpenAIClientClass> {
  _loadPromise ??= import(/* @vite-ignore */ "openai")
    .then((mod) => mod.default as OpenAIClientClass)
    .catch(() => {
      _loadPromise = undefined;
      throw new Error("openai is required for Meta tasks. Install it with: bun add openai");
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
   * {@link META_ALLOWED_HOSTS}. Use only for known-good custom gateways. The
   * URL still has to parse and use a safe scheme.
   */
  readonly trustedBaseUrl?: boolean;
}

let _testClient: unknown;

/**
 * Override the client returned by {@link getClient} so runtime tests can
 * exercise run-fns without a live SDK, API key, or network call. Pass
 * `undefined` to restore normal SDK-backed creation.
 */
function setMetaClientForTests(client: unknown): void {
  _testClient = client;
}

/**
 * Forget that a server refused `stream_options`, so a test starts from the
 * request a fresh process would send.
 */
function resetMetaStreamUsageSupportForTests(): void {
  _streamUsageRefused = false;
}

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. Surfaced on the `ai-runtime` barrel (via `export *`) and
 * merged into the `/ai` barrel's `_testOnly`.
 */
export const _testOnly = {
  setMetaClientForTests,
  resetMetaStreamUsageSupportForTests,
} as const;

export async function getClient(model: MetaModelConfig | undefined) {
  if (_testClient) return _testClient as InstanceType<OpenAIClientClass>;
  const OpenAI = await loadOpenAISDK();
  const config = model?.provider_config as ResolvedProviderConfig | undefined;
  const apiKey = resolveApiKey({
    config,
    envVar: META_API_KEY_ENV_VARS,
    providerLabel: "Meta",
  });
  // Throw before SDK construction on a rejected base_url so the API key is
  // never sent to an unvalidated host.
  const baseURL =
    validateProviderBaseUrl(config?.base_url, {
      vendor: "meta",
      allowHosts: META_ALLOWED_HOSTS,
      trustedBaseUrl: config?.trustedBaseUrl,
      providerLabel: "Meta",
    }) ?? META_DEFAULT_BASE_URL;
  try {
    return new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: isBrowserLike(),
    });
  } catch (err) {
    throw new Error(
      `Failed to create Meta client: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

export function getModelName(model: MetaModelConfig | undefined): string {
  const name = model?.provider_config?.model_name;
  if (!name) {
    throw new Error("Missing model name in provider_config.model_name.");
  }
  return name;
}

/**
 * `none` is absent on purpose: the Muse models reject it, and the effort
 * policy never offers it. `extra` and `ultra` reach Meta's two levels above
 * `high`; `ultra` is offered only on the models that accept `max`.
 */
const EFFORT_TO_META: Record<Exclude<ModelEffort, "none">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  ultra: "max",
};

const META_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Native `provider_config.reasoning_effort` wins over coarse `model.effort`
 * and is passed through for any value Meta documents, `minimal` included.
 * Undefined leaves the field off, so the model reasons at its own default
 * (`max` for Wonder and Ember, `high` for Spark).
 */
export function getMetaReasoningEffort(model: MetaModelConfig | undefined): string | undefined {
  const native = (model?.provider_config as { reasoning_effort?: unknown } | undefined)
    ?.reasoning_effort;
  if (typeof native === "string") {
    const trimmed = native.trim();
    if (META_REASONING_EFFORTS.has(trimmed)) return trimmed;
  }
  const effort = resolveEnabledEffort(model, metaEffortPolicy(model));
  if (effort !== undefined && effort !== "none") return EFFORT_TO_META[effort];
  return undefined;
}

/**
 * Sampling parameters the Meta Model API accepts. It answers `400` to
 * `frequency_penalty`, `presence_penalty` and `stop`, and to `temperature`
 * and `top_p` sent together, so those are never forwarded; when both are set
 * `temperature` wins.
 */
export function metaSamplingParams(input: {
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
}): { temperature?: number; top_p?: number } {
  if (input.temperature !== undefined) return { temperature: input.temperature };
  if (input.topP !== undefined) return { top_p: input.topP };
  return {};
}

let _streamUsageRefused = false;

function refusedStreamOptions(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 400) return false;
  const param = (err as { param?: unknown }).param;
  const message = (err as { message?: unknown }).message;
  return (
    (typeof param === "string" && param.includes("stream_options")) ||
    (typeof message === "string" && message.includes("stream_options"))
  );
}

/**
 * Open a streaming chat completion with usage reporting requested.
 *
 * Meta documents no `stream_options` and refuses parameters it does not take.
 * If it refuses this one, the request is sent again without it, and the
 * process stops asking. The stream then carries no billed usage and the
 * run-fn's provisional estimate is all the counter shows, which beats failing
 * every call.
 */
export async function createMetaChatStream(
  client: any,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<AsyncIterable<any>> {
  const request = { ...params, stream: true };
  if (!_streamUsageRefused) {
    try {
      return await client.chat.completions.create(
        { ...request, ...OPENAI_STREAM_USAGE_OPTIONS },
        { signal }
      );
    } catch (err) {
      if (!refusedStreamOptions(err)) throw err;
      _streamUsageRefused = true;
    }
  }
  return await client.chat.completions.create(request, { signal });
}
