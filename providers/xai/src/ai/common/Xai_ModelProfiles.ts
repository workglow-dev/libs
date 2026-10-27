/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

export interface XaiChatProfile {
  readonly kind: "chat";
  /** Takes image input. */
  readonly vision: boolean;
  /**
   * Takes `reasoning_effort`. xAI rejects the field on the ids that do not
   * reason, so a wrong `true` is a 400 where a wrong `false` drops the dial.
   */
  readonly reasoning: boolean;
}

/** Image generation, billed per image rather than per token. */
export interface XaiImageProfile {
  readonly kind: "image";
}

/**
 * What differs per xAI model. Capability inference, the effort policy, model
 * search and the pricing guard all read this one shape, so a model cannot be an
 * image model to the price list and a chat model to the request.
 */
export type XaiModelProfile = XaiChatProfile | XaiImageProfile;

const chat = (vision: boolean, reasoning: boolean): XaiChatProfile => ({
  kind: "chat",
  vision,
  reasoning,
});

const REASONING = chat(false, true);
const VISION_REASONING = chat(true, true);
const IMAGE: XaiImageProfile = { kind: "image" };

/**
 * One row per canonical id (see {@link normalizeXaiModelId}): adding a model is
 * a row here plus its price in `XAI_PRICING`, and the contract test fails until
 * both exist. An id with no row is answered by {@link XAI_MODEL_FAMILIES}.
 */
export const XAI_MODEL_PROFILES: Readonly<Record<string, XaiModelProfile>> = {
  "grok-4.6": VISION_REASONING,
  "grok-4.5": VISION_REASONING,
  "grok-4": VISION_REASONING,
  "grok-3": REASONING,
  "grok-3-mini": REASONING,
  "grok-2": REASONING,
  "grok-2-vision": VISION_REASONING,
};

/** Rows for models `XAI_PRICING` has no card for; the contract test allows exactly these. */
export const XAI_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set<string>();

/** The natively multimodal grok-4 family and the `-vision` ids take images. */
function grokTakesImages(id: string): boolean {
  return /vision|grok-4/.test(id);
}

/**
 * The answer for an id with no row. "image" counts only as a whole dash-delimited
 * segment, so an id that merely contains the letters (`reimagine-*`) is not
 * taken for an image model; and a `non-reasoning` id keeps the plain path.
 */
export const XAI_MODEL_FAMILIES: readonly ModelProfileFamily<XaiModelProfile>[] = [
  { when: /(?:^|-)image(?:-|$)/, profile: IMAGE },
  {
    when: (id) => id.startsWith("grok") && id.includes("non-reasoning") && grokTakesImages(id),
    profile: chat(true, false),
  },
  {
    when: (id) => id.startsWith("grok") && id.includes("non-reasoning"),
    profile: chat(false, false),
  },
  { when: (id) => id.startsWith("grok") && grokTakesImages(id), profile: VISION_REASONING },
  { when: /^grok/, profile: REASONING },
];

/** An id no row or family names: a text-only chat model with no reasoning, not recognized. */
const UNKNOWN: XaiModelProfile = chat(false, false);

/**
 * The canonical id for any spelling of an xAI model: the gateway's `xai/` (and
 * OpenRouter's `x-ai/`) prefix, and a trailing `MMDD` snapshot (`grok-2-vision-1212`)
 * or `-latest` alias, name the same model.
 */
export function normalizeXaiModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^x-?ai\//, "")
    .replace(/-(?:\d{4}|latest)$/, "");
}

export type XaiResolvedProfile = ResolvedModelProfile<XaiModelProfile>;

export const resolveXaiProfile: (modelName: string | undefined) => XaiResolvedProfile =
  makeModelProfileResolver<XaiModelProfile>({
    models: XAI_MODEL_PROFILES,
    families: XAI_MODEL_FAMILIES,
    normalize: normalizeXaiModelId,
    fallback: UNKNOWN,
  });

/** The task capabilities a profile serves. */
export function xaiProfileCapabilities(profile: XaiModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "image":
      return ["image.generation", "model.info", "model.search"];
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        "json-mode",
        "model.count-tokens",
        "model.info",
        "model.search",
        ...(profile.vision ? (["vision-input"] as const) : []),
      ];
  }
}
