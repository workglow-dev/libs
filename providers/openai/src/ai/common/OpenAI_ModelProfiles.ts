/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai/worker";

export type OpenAiModelKind = "chat" | "embedding" | "image-generation" | "image-editing";

/**
 * What differs per OpenAI model. Request building, capability inference and
 * model search all read this one shape, so a model cannot be an image model to
 * the list and a chat model to the request.
 */
export interface OpenAiModelProfile {
  readonly kind: OpenAiModelKind;
  /** Chat models only: takes image input. */
  readonly vision: boolean;
  /**
   * A pinned `temperature` is accepted when reasoning is switched to `none`.
   * Reasoning at any other effort rejects a temperature on every model, so this
   * only decides whether a request may turn reasoning off to keep one. A wrong
   * `true` sends a temperature the model may 400 on.
   */
  readonly acceptsTemperatureWithReasoning: boolean;
}

const chat = (acceptsTemperatureWithReasoning = false): OpenAiModelProfile => ({
  kind: "chat",
  vision: true,
  acceptsTemperatureWithReasoning,
});
const CHAT = chat();
const CHAT_TEMPERATURE_WITH_REASONING_NONE = chat(true);
const EMBEDDING: OpenAiModelProfile = {
  kind: "embedding",
  vision: false,
  acceptsTemperatureWithReasoning: false,
};
const IMAGE_EDITING: OpenAiModelProfile = {
  kind: "image-editing",
  vision: false,
  acceptsTemperatureWithReasoning: false,
};

/**
 * One row per canonical id (see {@link normalizeOpenAiModelId}): adding a model
 * is a row here plus its price in `OPENAI_PRICING`, and the contract test fails
 * until both exist.
 */
export const OPENAI_MODEL_PROFILES: Readonly<Record<string, OpenAiModelProfile>> = {
  "gpt-6-astra": CHAT,
  "gpt-6.1-sol": CHAT,
  "gpt-6-sol": CHAT,
  "gpt-6-luna": CHAT,
  "gpt-5.6": CHAT_TEMPERATURE_WITH_REASONING_NONE,
  "gpt-5.6-sol": CHAT_TEMPERATURE_WITH_REASONING_NONE,
  "gpt-5.6-terra": CHAT_TEMPERATURE_WITH_REASONING_NONE,
  "gpt-5.6-luna": CHAT_TEMPERATURE_WITH_REASONING_NONE,
  "gpt-5.5": CHAT,
  "gpt-5.4-mini": CHAT,
  "gpt-5.4-nano": CHAT,
  "gpt-5.4": CHAT,
  "gpt-5.2-mini": CHAT,
  "gpt-5.2": CHAT,
  "gpt-5-mini": CHAT,
  "gpt-5-nano": CHAT,
  "gpt-5": CHAT,
  "gpt-4.5": CHAT,
  "gpt-4.1": CHAT,
  "gpt-4.1-mini": CHAT,
  "gpt-4o": CHAT,
  "gpt-4o-mini": CHAT,
  "o3-mini": CHAT,
  o3: CHAT,
  o1: CHAT,
  "o1-mini": CHAT,
  "text-embedding-3-small": EMBEDDING,
  "text-embedding-3-large": EMBEDDING,
  "gpt-image-2.5-sunburst": IMAGE_EDITING,
  "gpt-image-2.5-flare": IMAGE_EDITING,
  "gpt-image-2": IMAGE_EDITING,
};

/** Rows for models `OPENAI_PRICING` has no card for; the contract test allows exactly these. */
export const OPENAI_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set(["gpt-5.6"]);

/**
 * The canonical id for any spelling of an OpenAI model: the gateway's `openai/`
 * prefix and a trailing snapshot date (`gpt-4o-2024-08-06`) name the same model.
 */
export function normalizeOpenAiModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

export type OpenAiProfileSource = "table" | "default";

export interface OpenAiResolvedProfile {
  /** `undefined` when the id is not recognizable as any OpenAI model family. */
  readonly profile: OpenAiModelProfile | undefined;
  readonly source: OpenAiProfileSource;
}

/**
 * The one answer for an id with no row, and the only place that guesses: the
 * family is read from the id's prefix, and nothing is assumed beyond it. A
 * temperature is never assumed to survive disabled reasoning, since a wrong
 * `true` is a 400 where a wrong `false` only drops the temperature with a warning.
 */
function defaultOpenAiProfile(id: string): OpenAiModelProfile | undefined {
  const base = { vision: false, acceptsTemperatureWithReasoning: false };
  if (id.startsWith("text-embedding")) return { ...base, kind: "embedding" };
  if (id.startsWith("dall-e")) return { ...base, kind: "image-generation" };
  if (id.startsWith("gpt-image")) return { ...base, kind: "image-editing" };
  if (/^gpt-/.test(id) || /^o\d/.test(id)) {
    const vision =
      /gpt-4o|gpt-4\.\d|gpt-5|gpt-6|gpt-4-vision|gpt-4-turbo/.test(id) || /^o\d/.test(id);
    return { ...base, kind: "chat", vision };
  }
  return undefined;
}

export function resolveOpenAiProfile(modelName: string | undefined): OpenAiResolvedProfile {
  const id = normalizeOpenAiModelId(modelName ?? "");
  if (Object.hasOwn(OPENAI_MODEL_PROFILES, id)) {
    return { profile: OPENAI_MODEL_PROFILES[id], source: "table" };
  }
  return { profile: defaultOpenAiProfile(id), source: "default" };
}

/** The task capabilities a profile serves. */
export function openAiProfileCapabilities(profile: OpenAiModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      return ["text.embedding", "model.count-tokens", "model.info", "model.search"];
    case "image-generation":
      return ["image.generation", "model.info", "model.search"];
    case "image-editing":
      return ["image.generation", "image.editing", "model.info", "model.search"];
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        "json-mode",
        "cache.checkpoint",
        "model.count-tokens",
        "model.info",
        "model.search",
        ...(profile.vision ? (["vision-input"] as const) : []),
      ];
  }
}
