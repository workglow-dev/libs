/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { resolveApiKey } from "@workglow/ai/provider-utils";
import { resolveEnabledEffort, type ModelEffort } from "@workglow/ai/worker";
import { GEMINI_API_VERSION } from "./Gemini_Constants";
import { geminiEffortPolicy } from "./Gemini_EffortPolicy";
import {
  GEMINI_THINKING_LEVELS,
  resolveGeminiChatProfile,
  type GeminiThinkingLevel,
} from "./Gemini_ModelProfiles";
import type { GeminiModelConfig } from "./Gemini_ModelSchema";

/** Maps coarse {@link ModelEffort} to Gemini thinkingBudget tokens. */
const EFFORT_TO_THINKING_BUDGET: Record<ModelEffort, number> = {
  none: 0,
  low: 512,
  medium: 1024,
  high: 2048,
  extra: 4096,
  ultra: 8192,
};

type GeminiSDKModule = typeof import("@google/genai");
type GoogleGenAIConstructor = GeminiSDKModule["GoogleGenAI"];

let _loadPromise: Promise<GoogleGenAIConstructor> | undefined;

// NOTE: we do not want to de-dup this in the provider-utils, vite wants direct import with string literals.
export async function loadGeminiSDK(): Promise<GoogleGenAIConstructor> {
  _loadPromise ??= import("@google/genai")
    .then((mod) => mod.GoogleGenAI)
    .catch(() => {
      _loadPromise = undefined;
      throw new Error(
        "@google/genai is required for Gemini tasks. Install it with: bun add @google/genai"
      );
    });
  return _loadPromise;
}

const _clientByKey = new Map<string, Promise<GoogleGenAI>>();

let _testClient: GoogleGenAI | undefined;

/**
 * Override the client returned by {@link createGeminiClient} so runtime tests
 * can capture the requests the Gemini run-fns build without a live SDK or
 * network call. Pass `undefined` to restore normal SDK-backed creation. Also
 * clears the per-key client cache so a previously memoized real client is not
 * reused across the override boundary.
 *
 * This lives in the runtime module (not a `vi.mock` of `@google/genai`) so it
 * works identically whether the provider resolves to `src` or the bundled
 * `dist`, and is immune to duplicate `@google/genai` copies across the
 * workspace defeating module-level mocks.
 */
function setGeminiClientForTests(client: GoogleGenAI | undefined): void {
  _testClient = client;
  _clientByKey.clear();
}

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. Surfaced on the `ai-runtime` barrel (via `export *`) and
 * merged into the `/ai` barrel's `_testOnly`.
 */
export const _testOnly = {
  setGeminiClientForTests,
} as const;

/**
 * Load the SDK and return a client bound to the resolved API key. The
 * `@google/genai` `GoogleGenAI` facade stands up auth wiring and several
 * sub-service objects, so it is memoized per API key rather than rebuilt on
 * every run-fn invocation. The in-flight promise is cached (set synchronously
 * before the first await) so concurrent calls for the same key share one client
 * instead of racing to construct duplicates; a failed load evicts the entry so
 * the next call can retry.
 */
export function createGeminiClient(model: GeminiModelConfig | undefined): Promise<GoogleGenAI> {
  if (_testClient) return Promise.resolve(_testClient);
  const apiKey = getApiKey(model);
  let clientPromise = _clientByKey.get(apiKey);
  if (!clientPromise) {
    clientPromise = loadGeminiSDK()
      .then((GoogleGenAICtor) => new GoogleGenAICtor({ apiKey, apiVersion: GEMINI_API_VERSION }))
      .catch((err) => {
        _clientByKey.delete(apiKey);
        throw err;
      });
    _clientByKey.set(apiKey, clientPromise);
  }
  return clientPromise;
}

interface ResolvedProviderConfig {
  readonly credential_key?: string;
  readonly api_key?: string;
  readonly model_name?: string;
  readonly embedding_task_type?: string | null;
}

export function getApiKey(model: GeminiModelConfig | undefined): string {
  const config = model?.provider_config as ResolvedProviderConfig | undefined;
  return resolveApiKey({
    config,
    envVar: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    providerLabel: "Google",
  });
}

export function getModelName(model: GeminiModelConfig | undefined): string {
  const name = model?.provider_config?.model_name;
  if (!name) {
    throw new Error("Missing model name in provider_config.model_name.");
  }
  return name;
}

/**
 * Whether the model accepts images inside `functionResponse.parts`, read off
 * its profile: Gemini 3 and later do, older ids answer such a request with a
 * 400, and the `-latest` aliases take the portable shape.
 */
export function geminiSupportsMultimodalFunctionResponses(modelName: string): boolean {
  return resolveGeminiChatProfile(modelName)?.multimodalFunctionResponses === true;
}

/**
 * Whether the model thinks, and so returns thought summaries, read off its
 * profile: Gemini 2.5 and later, and the `-latest` aliases. Earlier ids reject
 * `includeThoughts`.
 */
export function geminiReturnsThoughts(modelName: string | undefined): boolean {
  return resolveGeminiChatProfile(modelName)?.thinks === true;
}

/**
 * Reasoning-token budget for thinking models. Native
 * `provider_config.thinking_budget` wins; otherwise map `model.effort`.
 * Returns `undefined` when neither is set so callers can omit thinkingConfig.
 */
export function getThinkingBudget(model: GeminiModelConfig | undefined): number | undefined {
  const configured = model?.provider_config?.thinking_budget;
  if (typeof configured === "number") return configured;
  const effort = resolveEnabledEffort(model, geminiEffortPolicy(model));
  if (effort !== undefined) return EFFORT_TO_THINKING_BUDGET[effort];
  return undefined;
}

/**
 * Maps coarse {@link ModelEffort} to Gemini's thinking levels. `none` is
 * `minimal`: the 3.x models do not switch thinking off.
 */
const EFFORT_TO_THINKING_LEVEL: Record<ModelEffort, GeminiThinkingLevel> = {
  none: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  ultra: "xhigh",
};

/**
 * `wanted`, clamped into the levels the model takes, which are a contiguous
 * run of {@link GEMINI_THINKING_LEVELS}. Not every model takes every level —
 * Gemini 4 Argon has neither `minimal` nor `xhigh` — and a level it does not
 * take is a 400.
 */
function clampThinkingLevel(
  wanted: GeminiThinkingLevel,
  accepted: readonly GeminiThinkingLevel[]
): GeminiThinkingLevel {
  if (accepted.includes(wanted)) return wanted;
  const lowest = accepted[0]!;
  const below = GEMINI_THINKING_LEVELS.indexOf(wanted) < GEMINI_THINKING_LEVELS.indexOf(lowest);
  return below ? lowest : accepted[accepted.length - 1]!;
}

/**
 * Thinking level for the models that take one, which Google recommends over a
 * token budget there. `provider_config.thinking_level` wins; an explicit
 * `thinking_budget` is the caller's own choice and keeps the budget path;
 * otherwise `model.effort` maps to a level, clamped to the ones the model's
 * profile lists. Models before Gemini 3 list none, get `undefined` and use
 * {@link getThinkingBudget}. `xhigh` is accepted by the API but missing from the
 * SDK's `ThinkingLevel` enum, hence the cast.
 */
export function getThinkingLevel(model: GeminiModelConfig | undefined): ThinkingLevel | undefined {
  const accepted = resolveGeminiChatProfile(model?.provider_config?.model_name)?.thinkingLevels;
  if (accepted === undefined || accepted.length === 0) return undefined;
  const configured = model?.provider_config?.thinking_level;
  if (configured !== undefined) return configured as unknown as ThinkingLevel;
  if (typeof model?.provider_config?.thinking_budget === "number") return undefined;
  const effort = resolveEnabledEffort(model, geminiEffortPolicy(model));
  return effort === undefined
    ? undefined
    : (clampThinkingLevel(EFFORT_TO_THINKING_LEVEL[effort], accepted) as unknown as ThinkingLevel);
}

/**
 * Sampling seed for reproducible generation, from `provider_config.seed`.
 * Returns `undefined` when unset so the request omits the field entirely and
 * the model keeps its own (non-reproducible) sampling — matching how the other
 * optional sampling params are handled.
 *
 * Gemini is the only cloud provider here that exposes a seed at all: the OpenAI
 * Responses API rejects one outright (`400 Unknown parameter: 'seed'`) and
 * Anthropic has none, so aside from the local providers this is the single
 * lever for reproducible cloud extraction.
 */
export function getGeminiSeed(model: GeminiModelConfig | undefined): number | undefined {
  const seed = model?.provider_config?.seed;
  return typeof seed === "number" ? seed : undefined;
}

/**
 * Resolves the thinking-related request fields consistently across run-fns.
 * Gemini counts thinking tokens against `maxOutputTokens`, so a positive budget
 * is added on top of the caller's cap to leave room for the visible answer.
 *
 * @param defaultBudget applied when the model has no configured budget and no
 *   `effort`. Prefer omitting it — structured generation derives its own thinking
 *   budget.
 */
export function resolveThinkingConfig(
  model: GeminiModelConfig | undefined,
  maxTokens: number | undefined,
  defaultBudget?: number,
  options?: { readonly includeThoughts?: boolean | undefined }
): {
  thinkingConfig:
    | { thinkingBudget?: number; thinkingLevel?: ThinkingLevel; includeThoughts?: boolean }
    | undefined;
  maxOutputTokens: number | undefined;
} {
  // A level and a budget are alternatives; the API rejects both together, so a
  // level wins and no budget is sent or padded onto the output cap.
  const level = getThinkingLevel(model);
  const budget = level !== undefined ? undefined : (getThinkingBudget(model) ?? defaultBudget);
  // Thought summaries exist only when the model thinks: a zero budget turns
  // thinking off, and a model the profile says does not think rejects the config.
  const thinks = budget !== 0 && geminiReturnsThoughts(model?.provider_config?.model_name);
  const includeThoughts = options?.includeThoughts === true && thinks;
  if (budget === undefined && level === undefined && !includeThoughts) {
    return { thinkingConfig: undefined, maxOutputTokens: maxTokens };
  }
  const maxOutputTokens =
    maxTokens !== undefined && budget !== undefined && budget > 0 ? maxTokens + budget : maxTokens;
  return {
    thinkingConfig: {
      ...(budget !== undefined ? { thinkingBudget: budget } : {}),
      ...(level !== undefined ? { thinkingLevel: level } : {}),
      ...(includeThoughts ? { includeThoughts: true } : {}),
    },
    maxOutputTokens,
  };
}
