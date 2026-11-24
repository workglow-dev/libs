/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/** Every `reasoning_effort` value the xAI API defines, lowest first. */
export const XAI_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export type XaiReasoningEffort = (typeof XAI_REASONING_EFFORTS)[number];

export interface XaiChatProfile {
  readonly kind: "chat";
  /** Takes image input. */
  readonly vision: boolean;
  /**
   * Takes `reasoning_effort`. xAI rejects the field on the ids that do not
   * reason, so a wrong `true` is a 400 where a wrong `false` drops the dial.
   */
  readonly reasoning: boolean;
  /**
   * The `reasoning_effort` values the model accepts, lowest first; empty when it
   * does not reason. Grok 4.6 and 4.7 cannot turn reasoning off and add
   * `xhigh`; Grok 4.5 stops at `high`; Grok 4.3 takes `none`.
   */
  readonly efforts: readonly XaiReasoningEffort[];
  /**
   * The level xAI applies when the field is omitted, shown as the dial's
   * default; `none` for a model that does not reason.
   */
  readonly defaultEffort: XaiReasoningEffort;
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

const chat = (
  vision: boolean,
  efforts: readonly XaiReasoningEffort[] = [],
  defaultEffort: XaiReasoningEffort = efforts.length > 0 ? "medium" : "none"
): XaiChatProfile => ({
  kind: "chat",
  vision,
  reasoning: efforts.length > 0,
  efforts,
  defaultEffort,
});

/**
 * The levels the earlier reasoning ids took. The retired ones (grok-4, grok-3)
 * now answer through grok-4.3, which takes the same four.
 */
const EARLIER_EFFORTS = ["none", "low", "medium", "high"] as const;

const REASONING = chat(false, EARLIER_EFFORTS);
const VISION_REASONING = chat(true, EARLIER_EFFORTS);
const GROK_4_6 = chat(true, ["low", "medium", "high", "xhigh"], "high");
const GROK_4_5 = chat(true, ["low", "medium", "high"], "high");
const GROK_4_3 = chat(true, EARLIER_EFFORTS, "low");
const IMAGE: XaiImageProfile = { kind: "image" };

/**
 * One row per canonical id (see {@link normalizeXaiModelId}): adding a model is
 * a row here plus its price in `XAI_PRICING`, and the contract test fails until
 * both exist. An id with no row is answered by {@link XAI_MODEL_FAMILIES}.
 */
export const XAI_MODEL_PROFILES: Readonly<Record<string, XaiModelProfile>> = {
  "grok-4.7": GROK_4_6,
  "grok-4.6": GROK_4_6,
  "grok-4.5": GROK_4_5,
  "grok-4.3": GROK_4_3,
  "grok-4": VISION_REASONING,
  "grok-3": REASONING,
  "grok-3-mini": REASONING,
  // Grok 2 predates reasoning: a `reasoning_effort` sent to it is rejected.
  "grok-2": chat(false),
  "grok-2-vision": chat(true),
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
  // The retired beta ids predate reasoning, as Grok 2 does.
  { when: /^grok-beta$/, profile: chat(false) },
  { when: /^grok-vision-beta$/, profile: chat(true) },
  {
    when: (id) => id.startsWith("grok") && id.includes("non-reasoning") && grokTakesImages(id),
    profile: chat(true),
  },
  {
    when: (id) => id.startsWith("grok") && id.includes("non-reasoning"),
    profile: chat(false),
  },
  { when: (id) => id.startsWith("grok") && grokTakesImages(id), profile: VISION_REASONING },
  { when: /^grok/, profile: REASONING },
];

/** An id no row or family names: a text-only chat model with no reasoning, not recognized. */
const UNKNOWN: XaiModelProfile = chat(false);

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
