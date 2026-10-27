/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/**
 * Whether a chat model takes the Responses `reasoning` field:
 * - `none` — it does not, and answers one with a 400.
 * - `optional` — every effort, `none` included.
 * - `always` — it always reasons, and answers `effort: "none"` with a 400.
 */
export type OpenAiReasoning = "none" | "optional" | "always";

export interface OpenAiChatProfile {
  readonly kind: "chat";
  /** Takes image input. */
  readonly vision: boolean;
  readonly reasoning: OpenAiReasoning;
  /**
   * A pinned `temperature` is accepted when reasoning is switched to `none`.
   * Reasoning at any other effort rejects a temperature on every model, so this
   * only decides whether a request may turn reasoning off to keep one. A wrong
   * `true` sends a temperature the model may 400 on.
   */
  readonly acceptsTemperatureWithReasoning: boolean;
}

export interface OpenAiEmbeddingProfile {
  readonly kind: "embedding";
}

export interface OpenAiImageProfile {
  readonly kind: "image";
  /** Which edits the model takes: none, one input image, or several. */
  readonly editing: "none" | "single" | "multi";
  /** Streams partial frames (`stream: true`); otherwise one non-streaming call. */
  readonly streamsPartialImages: boolean;
}

/**
 * What differs per OpenAI model. Request building, capability inference, the
 * effort policy, image validation and model search all read this one shape, so
 * a model cannot be an image model to the list and a chat model to the request.
 */
export type OpenAiModelProfile = OpenAiChatProfile | OpenAiEmbeddingProfile | OpenAiImageProfile;

const chat = (
  reasoning: OpenAiReasoning,
  overrides: Partial<Omit<OpenAiChatProfile, "kind" | "reasoning">> = {}
): OpenAiChatProfile => ({
  kind: "chat",
  vision: true,
  reasoning,
  acceptsTemperatureWithReasoning: false,
  ...overrides,
});

/** The gpt-6 family always reasons. */
const ALWAYS_REASONING = chat("always");
const REASONING = chat("optional");
/** The GPT-5.6 family keeps a pinned temperature when reasoning is turned off. */
const REASONING_WITH_TEMPERATURE = chat("optional", { acceptsTemperatureWithReasoning: true });
const NO_REASONING = chat("none");
const EMBEDDING: OpenAiEmbeddingProfile = { kind: "embedding" };
const GPT_IMAGE: OpenAiImageProfile = {
  kind: "image",
  editing: "multi",
  streamsPartialImages: true,
};

/**
 * One row per canonical id (see {@link normalizeOpenAiModelId}): adding a model
 * is a row here plus its price in `OPENAI_PRICING`, and the contract test fails
 * until both exist. An id with no row is answered by {@link OPENAI_MODEL_FAMILIES}.
 */
export const OPENAI_MODEL_PROFILES: Readonly<Record<string, OpenAiModelProfile>> = {
  "gpt-6-astra": ALWAYS_REASONING,
  "gpt-6.1-sol": ALWAYS_REASONING,
  "gpt-6-sol": ALWAYS_REASONING,
  "gpt-6-luna": ALWAYS_REASONING,
  "gpt-5.6": REASONING_WITH_TEMPERATURE,
  "gpt-5.6-sol": REASONING_WITH_TEMPERATURE,
  "gpt-5.6-terra": REASONING_WITH_TEMPERATURE,
  "gpt-5.6-luna": REASONING_WITH_TEMPERATURE,
  "gpt-5.5": REASONING,
  "gpt-5.4-mini": REASONING,
  "gpt-5.4-nano": REASONING,
  "gpt-5.4": REASONING,
  "gpt-5.2-mini": REASONING,
  "gpt-5.2": REASONING,
  "gpt-5-mini": REASONING,
  "gpt-5-nano": REASONING,
  "gpt-5": REASONING,
  "gpt-4.5": NO_REASONING,
  "gpt-4.1": NO_REASONING,
  "gpt-4.1-mini": NO_REASONING,
  "gpt-4o": NO_REASONING,
  "gpt-4o-mini": NO_REASONING,
  // The small o-series models take text only.
  "o3-mini": chat("optional", { vision: false }),
  o3: REASONING,
  o1: REASONING,
  "o1-mini": chat("optional", { vision: false }),
  "text-embedding-3-small": EMBEDDING,
  "text-embedding-3-large": EMBEDDING,
  "gpt-image-2.5-sunburst": GPT_IMAGE,
  "gpt-image-2.5-flare": GPT_IMAGE,
  "gpt-image-2": GPT_IMAGE,
};

/** Rows for models `OPENAI_PRICING` has no card for; the contract test allows exactly these. */
export const OPENAI_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set(["gpt-5.6"]);

/**
 * The answer for an id with no row, read from its family prefix and nothing
 * beyond it. A temperature is never assumed to survive disabled reasoning, since
 * a wrong `true` is a 400 where a wrong `false` only drops the temperature with
 * a warning; and a chat family not named here takes no `reasoning` field, since
 * the chat models that reject it — `gpt-4o`, `gpt-4.1` — are most of what is left.
 */
export const OPENAI_MODEL_FAMILIES: readonly ModelProfileFamily<OpenAiModelProfile>[] = [
  { when: /^text-embedding/, profile: EMBEDDING },
  // DALL-E streams nothing; DALL-E 2 edits one image, DALL-E 3 none.
  {
    when: /^dall-e-2/,
    profile: { kind: "image", editing: "single", streamsPartialImages: false },
  },
  { when: /^dall-e/, profile: { kind: "image", editing: "none", streamsPartialImages: false } },
  { when: /^gpt-image/, profile: GPT_IMAGE },
  { when: /^gpt-6/, profile: ALWAYS_REASONING },
  { when: [/^gpt-5/, /^o[134]/], profile: REASONING },
  {
    when: [/^o\d/, /^gpt-4o/, /^gpt-4\.\d/, /^gpt-4-vision/, /^gpt-4-turbo/],
    profile: NO_REASONING,
  },
  { when: /^gpt-/, profile: chat("none", { vision: false }) },
];

/** An id no row or family names: a text-only chat model with no reasoning, not recognized. */
const UNKNOWN: OpenAiModelProfile = chat("none", { vision: false });

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

export type OpenAiResolvedProfile = ResolvedModelProfile<OpenAiModelProfile>;

export const resolveOpenAiProfile: (modelName: string | undefined) => OpenAiResolvedProfile =
  makeModelProfileResolver<OpenAiModelProfile>({
    models: OPENAI_MODEL_PROFILES,
    families: OPENAI_MODEL_FAMILIES,
    normalize: normalizeOpenAiModelId,
    fallback: UNKNOWN,
  });

/** The task capabilities a profile serves. */
export function openAiProfileCapabilities(profile: OpenAiModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      return ["text.embedding", "model.count-tokens", "model.info", "model.search"];
    case "image":
      return [
        "image.generation",
        ...(profile.editing === "none" ? [] : (["image.editing"] as const)),
        "model.info",
        "model.search",
      ];
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
