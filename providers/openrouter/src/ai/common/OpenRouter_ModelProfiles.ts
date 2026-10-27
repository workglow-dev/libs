/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/** A model OpenRouter serves over chat completions, the one surface this package runs. */
export interface OpenRouterChatProfile {
  readonly kind: "chat";
}

/**
 * A model with no chat surface: no `reasoning` field to carry the dial, and no
 * run-fn here that could serve it.
 */
export interface OpenRouterNonTextProfile {
  readonly kind: "embedding" | "image" | "audio" | "rerank" | "moderation";
}

/**
 * What the id alone says about an OpenRouter model. The catalogue is
 * open-ended, so there are no rows: only family rules over the id, and `/models`
 * metadata, when a record carries it, still decides the capabilities.
 */
export type OpenRouterModelProfile = OpenRouterChatProfile | OpenRouterNonTextProfile;

export type OpenRouterModelKind = OpenRouterModelProfile["kind"];

const CHAT: OpenRouterChatProfile = { kind: "chat" };

/**
 * Ids are `vendor/model`, so a family name can sit either at the start or
 * straight after the slash. Every family names a modality with no chat surface;
 * a chat model needs no rule, since chat is what the fallback assumes.
 */
export const OPENROUTER_MODEL_FAMILIES: readonly ModelProfileFamily<OpenRouterModelProfile>[] = [
  { when: [/embedding/, /(?:^|[/-])embed(?:$|-)/], profile: { kind: "embedding" } },
  {
    when: [
      /(?:^|\/)(?:dall-e|gpt-image|imagen|flux|sdxl|stable-diffusion|playground|recraft|ideogram|kandinsky)/,
      /-image(?:$|-)/,
    ],
    profile: { kind: "image" },
  },
  { when: /(?:^|\/)(?:whisper|tts)(?:$|-)/, profile: { kind: "audio" } },
  { when: /(?:^|\/)rerank/, profile: { kind: "rerank" } },
  { when: /moderation/, profile: { kind: "moderation" } },
];

/**
 * The canonical id for any spelling of an OpenRouter model. A `:variant`
 * suffix (`:free`, `:thinking`, `:online`, `:nitro`) is a routing choice over
 * the same model, so it names no different profile.
 */
export function normalizeOpenRouterModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/:[^/]*$/, "");
}

export type OpenRouterResolvedProfile = ResolvedModelProfile<OpenRouterModelProfile>;

/**
 * An id no family names is a chat model: every entry `/models` lists serves
 * chat completions, and OpenRouter drops a parameter the routed model does not
 * accept rather than rejecting the request, so guessing chat costs nothing.
 */
export const resolveOpenRouterProfile: (
  modelName: string | undefined
) => OpenRouterResolvedProfile = makeModelProfileResolver<OpenRouterModelProfile>({
  families: OPENROUTER_MODEL_FAMILIES,
  normalize: normalizeOpenRouterModelId,
  fallback: CHAT,
});

/** What every OpenRouter chat model serves before `/models` metadata adds to it. */
export const OPENROUTER_BASELINE_CHAT: readonly Capability[] = [
  "text.generation",
  "text.rewriter",
  "text.summary",
  "model.count-tokens",
  "model.info",
  "model.search",
];

/** The task capabilities a profile serves when no `/models` metadata says more. */
export function openRouterProfileCapabilities(
  profile: OpenRouterModelProfile
): readonly Capability[] {
  switch (profile.kind) {
    case "chat":
      return OPENROUTER_BASELINE_CHAT;
    case "embedding":
    case "image":
    case "audio":
    case "rerank":
    case "moderation":
      return ["model.info", "model.search"];
  }
}
