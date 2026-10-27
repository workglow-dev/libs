/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

export interface GeminiChatProfile {
  readonly kind: "chat";
  /** Takes image input. */
  readonly vision: boolean;
  /**
   * Takes `thinkingConfig` — the effort dial and `includeThoughts`. Models before
   * Gemini 2.5 answer the config with a 400, so a wrong `true` fails the request
   * where a wrong `false` only drops the dial.
   */
  readonly thinks: boolean;
  /**
   * Accepts images inside `functionResponse.parts`. Only Gemini 3 and later do;
   * older ids answer such a request with a 400, so they take the portable shape.
   */
  readonly multimodalFunctionResponses: boolean;
  /** Serves `cachedContents` and `countTokens`, which the legacy 1.0 ids predate. */
  readonly cachedContent: boolean;
}

export interface GeminiEmbeddingProfile {
  readonly kind: "embedding";
}

export interface GeminiImageProfile {
  readonly kind: "image";
  /** Edits an input image. Imagen only generates. */
  readonly editing: boolean;
}

/**
 * What differs per Gemini model. Capability inference, the effort policy, the
 * thinking and tool-result request shapes, model search and the pricing guard
 * all read this one shape, so a model cannot think where a request is built and
 * not where it is listed.
 */
export type GeminiModelProfile = GeminiChatProfile | GeminiEmbeddingProfile | GeminiImageProfile;

const chat = (overrides: Partial<Omit<GeminiChatProfile, "kind">> = {}): GeminiChatProfile => ({
  kind: "chat",
  vision: true,
  thinks: true,
  multimodalFunctionResponses: false,
  cachedContent: true,
  ...overrides,
});

/** Gemini 3 and later: thinking, and images inside a tool result. */
const GENERATION_3 = chat({ multimodalFunctionResponses: true });
/** Gemini 2.5 and the `-latest` aliases: thinking, images beside a tool result. */
const THINKING = chat();
/** Gemini 1.5 and 2.0: the modern API surface, no thinking. */
const PRE_THINKING = chat({ thinks: false });
/** The 1.0 text models: no image input, no thinking, no cached content or token counting. */
const LEGACY = chat({ vision: false, thinks: false, cachedContent: false });
const EMBEDDING: GeminiEmbeddingProfile = { kind: "embedding" };
const GEMINI_IMAGE: GeminiImageProfile = { kind: "image", editing: true };
const IMAGEN: GeminiImageProfile = { kind: "image", editing: false };

/**
 * One row per canonical id (see {@link normalizeGeminiModelId}): adding a model
 * is a row here plus its price in `GEMINI_PRICING`, and the contract test fails
 * until both exist. An id with no row is answered by {@link GEMINI_MODEL_FAMILIES}.
 */
export const GEMINI_MODEL_PROFILES: Readonly<Record<string, GeminiModelProfile>> = {
  "gemini-3.8-flash": GENERATION_3,
  "gemini-3.7-flash": GENERATION_3,
  "gemini-3.6-flash": GENERATION_3,
  "gemini-3.5-flash-lite": GENERATION_3,
  "gemini-3.5-flash": GENERATION_3,
  "gemini-3.1-flash-lite": GENERATION_3,
  "gemini-3.1-pro-preview": GENERATION_3,
  "gemini-3.1-pro": GENERATION_3,
  "gemini-3-flash": GENERATION_3,
  "gemini-2.5-flash-lite": THINKING,
  "gemini-2.5-flash": THINKING,
  "gemini-2.5-pro": THINKING,
  "gemini-embedding-2": EMBEDDING,
  "text-embedding-004": EMBEDDING,
  "gemini-3.1-flash-image": GEMINI_IMAGE,
  "gemini-3-pro-image": GEMINI_IMAGE,
  "imagen-4.0-generate-001": IMAGEN,
  // The legacy ids carry no version, so no family can place them.
  "gemini-pro": LEGACY,
  "gemini-pro-vision": chat({ thinks: false, cachedContent: false }),
};

/** Rows for models `GEMINI_PRICING` has no card for; the contract test allows exactly these. */
export const GEMINI_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set([
  "gemini-pro",
  "gemini-pro-vision",
]);

/**
 * The answer for an id with no row, read from its prefix and version. Embedding
 * and image ids come first because they share the `gemini-` prefix with the
 * chat models; a `gemini-` id with no version these name (`gemini-ultra`,
 * `gemini-exp-1206`) is left to the fallback rather than handed a thinking
 * config it may reject.
 */
export const GEMINI_MODEL_FAMILIES: readonly ModelProfileFamily<GeminiModelProfile>[] = [
  { when: [/^text-embedding/, /^embedding-\d/, /^gemini-embedding/], profile: EMBEDDING },
  { when: /^imagen-/, profile: IMAGEN },
  { when: /^gemini-.*-image(?:-|$)/, profile: GEMINI_IMAGE },
  { when: /^gemini-1\.0-pro(?:$|-(?!vision))/, profile: LEGACY },
  { when: /^gemini-(?:1\.5|2\.0)/, profile: PRE_THINKING },
  { when: /^gemini-2\.5(?:[.-]|$)/, profile: THINKING },
  { when: /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/, profile: GENERATION_3 },
  // `gemini-flash-latest` and kin point at a current thinking model, but a
  // request cannot tell which generation, so tool images take the portable shape.
  { when: /^gemini-[a-z-]*-latest$/, profile: THINKING },
];

/** An id no row or family names: a text-only chat model that does not think, not recognized. */
const UNKNOWN: GeminiModelProfile = chat({
  vision: false,
  thinks: false,
  cachedContent: false,
});

/**
 * The canonical id for any spelling of a Gemini model: the API's `models/`
 * resource prefix and the gateway prefixes the pricing table strips name the
 * same model.
 */
export function normalizeGeminiModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^(?:models|google|google-gemini)\//, "");
}

export type GeminiResolvedProfile = ResolvedModelProfile<GeminiModelProfile>;

export const resolveGeminiProfile: (modelName: string | undefined) => GeminiResolvedProfile =
  makeModelProfileResolver<GeminiModelProfile>({
    models: GEMINI_MODEL_PROFILES,
    families: GEMINI_MODEL_FAMILIES,
    normalize: normalizeGeminiModelId,
    fallback: UNKNOWN,
  });

/** The chat profile for a model, or `undefined` for an embedding or image model. */
export function resolveGeminiChatProfile(
  modelName: string | undefined
): GeminiChatProfile | undefined {
  const { profile } = resolveGeminiProfile(modelName);
  return profile.kind === "chat" ? profile : undefined;
}

/** The task capabilities a profile serves. */
export function geminiProfileCapabilities(profile: GeminiModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      return ["text.embedding", "model.info", "model.search"];
    case "image":
      return [
        "image.generation",
        ...(profile.editing ? (["image.editing"] as const) : []),
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
        ...(profile.vision ? (["vision-input"] as const) : []),
        ...(profile.cachedContent
          ? (["cache.checkpoint", "session.dispose", "model.count-tokens"] as const)
          : []),
        "model.info",
        "model.search",
      ];
  }
}
