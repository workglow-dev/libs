/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/**
 * What differs per DeepSeek model: whether it reasons — which DeepSeek splits by
 * id rather than by parameter — and whether it reads images. Capability
 * inference, the effort policy, the thinking switch, the reasoning allowance,
 * tool-result images and model search all read it here.
 */
export interface DeepSeekModelProfile {
  /**
   * Takes `reasoning_effort` and the `thinking` switch, and bills reasoning
   * tokens against `max_tokens`.
   */
  readonly reasoning: boolean;
  /**
   * Reads images, in user and tool messages alike. DeepSeek Flash does since
   * V4.1; V4 Pro and the retired chat/reasoner ids read text only.
   */
  readonly vision: boolean;
}

const REASONING: DeepSeekModelProfile = { reasoning: true, vision: false };
const REASONING_VISION: DeepSeekModelProfile = { reasoning: true, vision: true };
const CHAT: DeepSeekModelProfile = { reasoning: false, vision: false };

/**
 * One row per canonical id (see {@link normalizeDeepSeekModelId}): adding a
 * model is a row here plus its price in `DEEPSEEK_PRICING`, and the contract
 * test fails until both exist. An id with no row is answered by
 * {@link DEEPSEEK_MODEL_FAMILIES}.
 */
export const DEEPSEEK_MODEL_PROFILES: Readonly<Record<string, DeepSeekModelProfile>> = {
  "deepseek-flash": REASONING_VISION,
  // Retired, and served by DeepSeek Flash (V4.1) at its price.
  "deepseek-v4-flash": REASONING_VISION,
  "deepseek-v4-pro": REASONING,
  // `deepseek-reasoner` is the thinking mode of the weights `deepseek-chat`
  // serves without it.
  "deepseek-reasoner": REASONING,
  "deepseek-chat": CHAT,
};

/** Rows for models `DEEPSEEK_PRICING` has no card for; the contract test allows exactly these. */
export const DEEPSEEK_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set<string>();

/** V4 is the first family that reasons on every id; before it the mode is the id. */
function isReasoningDeepSeekFamily(id: string): boolean {
  const version = /^deepseek-v(\d+)/.exec(id);
  return version !== null && Number(version[1]) >= 4;
}

/**
 * The answer for an id with no row. Any other `deepseek-` id is a text-only
 * chat model that does not reason (`deepseek-v3`, `deepseek-coder`).
 */
export const DEEPSEEK_MODEL_FAMILIES: readonly ModelProfileFamily<DeepSeekModelProfile>[] = [
  { when: /^deepseek-flash/, profile: REASONING_VISION },
  {
    when: [isReasoningDeepSeekFamily, /^deepseek-reasoner/, /^deepseek-r\d/],
    profile: REASONING,
  },
  { when: /^deepseek/, profile: CHAT },
];

/**
 * The canonical id for any spelling of a DeepSeek model: the gateway's
 * `deepseek/` prefix and a trailing `MMDD` snapshot (`deepseek-v4-flash-0731`)
 * name the same model. A snapshot shares its base id's card and behavior.
 */
export function normalizeDeepSeekModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^deepseek\//, "")
    .replace(/-\d{4}$/, "");
}

export type DeepSeekResolvedProfile = ResolvedModelProfile<DeepSeekModelProfile>;

export const resolveDeepSeekProfile: (modelName: string | undefined) => DeepSeekResolvedProfile =
  makeModelProfileResolver<DeepSeekModelProfile>({
    models: DEEPSEEK_MODEL_PROFILES,
    families: DEEPSEEK_MODEL_FAMILIES,
    normalize: normalizeDeepSeekModelId,
    fallback: CHAT,
  });

/** The task capabilities a profile serves: the same text set whether or not it reasons. */
export function deepSeekProfileCapabilities(profile: DeepSeekModelProfile): readonly Capability[] {
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
