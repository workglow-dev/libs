/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

export interface MetaChatProfile {
  readonly kind: "chat";
  /** Takes image input (in a user message only; see `toolImagesInUserMessage`). */
  readonly vision: boolean;
  /**
   * Takes `reasoning_effort`. Every Muse chat model reasons; an id whose
   * family is unknown keeps the plain path rather than risk a 400.
   */
  readonly reasoning: boolean;
  /**
   * Accepts `reasoning_effort: "max"`. Meta serves it on Muse Wonder, Muse
   * Ember and Muse Spark 1.3, but not on earlier Spark versions or on any
   * contributor variant, which reject it.
   */
  readonly maxEffort: boolean;
  /**
   * Reasons at `max` when `reasoning_effort` is omitted, as Muse Wonder and
   * Ember do; every Muse Spark version, 1.3 included, reasons at `high`.
   */
  readonly defaultsToMax: boolean;
}

/**
 * A model on the same base URL that does not chat: image generation, speech
 * transcription, segmentation. None is billed per token and no run-fn here
 * serves one, so it advertises only the meta-ops.
 */
export interface MetaOtherProfile {
  readonly kind: "other";
}

/**
 * What differs per Meta model. Capability inference, the effort policy, model
 * search and the pricing guard all read this one shape.
 */
export type MetaModelProfile = MetaChatProfile | MetaOtherProfile;

const chat = (maxEffort: boolean, defaultsToMax: boolean): MetaChatProfile => ({
  kind: "chat",
  vision: true,
  reasoning: true,
  maxEffort,
  defaultsToMax,
});

const MUSE_MAX = chat(true, true);
const MUSE_SPARK_MAX = chat(true, false);
const MUSE = chat(false, false);
const OTHER: MetaOtherProfile = { kind: "other" };

/**
 * One row per canonical id (see {@link normalizeMetaModelId}): adding a model is
 * a row here plus its price in `META_PRICING`, and the contract test fails until
 * both exist. An id with no row is answered by {@link META_MODEL_FAMILIES}.
 */
export const META_MODEL_PROFILES: Readonly<Record<string, MetaModelProfile>> = {
  "muse-wonder-1.0": MUSE_MAX,
  "muse-ember-1.0": MUSE_MAX,
  "muse-spark-1.3": MUSE_SPARK_MAX,
  "muse-spark-1.2": MUSE,
  "muse-spark-1.1": MUSE,
  "muse-spark-1.3-contributor": MUSE,
  "muse-spark-1.2-contributor": MUSE,
};

/** Rows for models `META_PRICING` has no card for; the contract test allows exactly these. */
export const META_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * The answer for an id with no row. The non-chat models are matched first so a
 * `muse-image-*` or `muse-voice-*` id is never taken for a chat model; a
 * contributor variant never takes `max`, whatever its base version.
 */
export const META_MODEL_FAMILIES: readonly ModelProfileFamily<MetaModelProfile>[] = [
  { when: /^muse-(?:image|voice)(?:-|$)/, profile: OTHER },
  { when: /^sam-/, profile: OTHER },
  { when: /^muse-.*-contributor$/, profile: MUSE },
  { when: /^muse-(?:wonder|ember)(?:-|$)/, profile: MUSE_MAX },
  { when: /^muse-/, profile: MUSE },
];

/**
 * An id no row or family names: a text-only chat model with no reasoning, not
 * recognized. Llama-era ids (`Llama-4-Maverick-…`) land here: the Llama API
 * that served them was retired, and Meta's current API does not list them.
 */
const UNKNOWN: MetaModelProfile = {
  kind: "chat",
  vision: false,
  reasoning: false,
  maxEffort: false,
  defaultsToMax: false,
};

/**
 * The canonical id for any spelling of a Meta model: a gateway's `meta/`,
 * `meta-ai/` or `meta:` prefix and a trailing `-latest` alias name the same
 * model. The `-contributor` suffix is kept: it is a different price and a
 * different data-use policy, not a spelling.
 */
export function normalizeMetaModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^meta(?:-ai)?[/:]/, "")
    .replace(/-latest$/, "");
}

export type MetaResolvedProfile = ResolvedModelProfile<MetaModelProfile>;

export const resolveMetaProfile: (modelName: string | undefined) => MetaResolvedProfile =
  makeModelProfileResolver<MetaModelProfile>({
    models: META_MODEL_PROFILES,
    families: META_MODEL_FAMILIES,
    normalize: normalizeMetaModelId,
    fallback: UNKNOWN,
  });

/** The task capabilities a profile serves. */
export function metaProfileCapabilities(profile: MetaModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "other":
      return ["model.info", "model.search"];
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
