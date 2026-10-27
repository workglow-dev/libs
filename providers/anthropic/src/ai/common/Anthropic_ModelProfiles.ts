/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";
import { normalizeAnthropicModelId, parseAnthropicModelId } from "./Anthropic_ModelId";

/**
 * How a request asks for extended thinking:
 * - `none` — the model predates thinking and 400s on any thinking field.
 * - `budget` — `thinking.type = "enabled"` with `budget_tokens`.
 * - `adaptive` — `thinking.type = "adaptive"` with `output_config.effort`.
 */
export type AnthropicThinkingShape = "none" | "budget" | "adaptive";

/**
 * What a request sends for an effort of `none`:
 * - `omit` — omitting `thinking` already means no thinking.
 * - `between_tools` — the model's real off switch.
 * - `low_effort` — the model thinks whenever `thinking` is omitted and has no
 *   off switch, so the closest it gets is `output_config.effort = "low"`.
 *
 * Anything but `omit` also means the model thinks adaptively when `thinking`
 * is omitted, so a request with no effort says so on the wire.
 */
export type AnthropicMinimalThinking = "omit" | "between_tools" | "low_effort";

/**
 * What differs per Claude model. Request building, capability inference, the
 * effort policy and model search all read this one shape, so a flag cannot be
 * decided one way where a request is built and another where a model is listed.
 */
export interface AnthropicModelProfile {
  /** Accepts `output_config.format`. A wrong `true` is an unrecoverable 400. */
  readonly supportsOutputFormat: boolean;
  /** Accepts a forced `tool_choice` (`any` or `tool`). A wrong `true` is an unrecoverable 400. */
  readonly acceptsForcedToolChoice: boolean;
  /** Accepts `temperature` / `top_p`. A wrong `true` is an unrecoverable 400. */
  readonly acceptsSamplingParams: boolean;
  /** Takes image input. */
  readonly vision: boolean;
  /** Accepts `cache_control` breakpoints. */
  readonly promptCaching: boolean;
  readonly thinking: AnthropicThinkingShape;
  readonly minimalThinking: AnthropicMinimalThinking;
}

/** Generation 5's newest behavior: native output format, no forced tool choice, no sampling. */
const NEWEST: AnthropicModelProfile = {
  supportsOutputFormat: true,
  acceptsForcedToolChoice: false,
  acceptsSamplingParams: false,
  vision: true,
  promptCaching: true,
  thinking: "adaptive",
  minimalThinking: "low_effort",
};
/** The first generation-5 releases, which still took a forced tool choice. */
const GENERATION_5: AnthropicModelProfile = { ...NEWEST, acceptsForcedToolChoice: true };

/** Generation 4 from 4.6 on: adaptive thinking, the tool route for structured output. */
const ADAPTIVE_4: AnthropicModelProfile = {
  supportsOutputFormat: false,
  acceptsForcedToolChoice: true,
  acceptsSamplingParams: true,
  vision: true,
  promptCaching: true,
  thinking: "adaptive",
  minimalThinking: "omit",
};
/** Claude 3.7 through 4.5: a thinking budget, sampling accepted. */
const BUDGET: AnthropicModelProfile = { ...ADAPTIVE_4, thinking: "budget" };
/** Claude 3 and 3.5, which predate thinking. */
const PRE_THINKING: AnthropicModelProfile = { ...BUDGET, thinking: "none" };
/** Claude 2 and earlier: no image input, no prompt caching, no thinking. */
const PRE_VISION: AnthropicModelProfile = { ...PRE_THINKING, vision: false, promptCaching: false };
/**
 * An id the parser cannot read. A wrong `false` costs only the older route and
 * a wrong `true` is a 400, so every request flag is `false` except the forced
 * tool choice every pre-generation-5 model accepts; the effort dial is kept,
 * since such an id is far likelier a spelling not yet seen than a model without
 * thinking, and the budget route is the one every thinking model accepts.
 */
const UNREADABLE: AnthropicModelProfile = { ...BUDGET, acceptsSamplingParams: false };

/**
 * One row per canonical id (see {@link normalizeAnthropicModelId}): adding a
 * model is a row here plus its price in `ANTHROPIC_PRICING`, and the contract
 * test fails until both exist. The unpriced rows are ids whose behavior differs
 * from what {@link defaultAnthropicProfile} would answer for them.
 */
export const ANTHROPIC_MODEL_PROFILES: Readonly<Record<string, AnthropicModelProfile>> = {
  "claude-fable-5-1": NEWEST,
  "claude-fable-5": GENERATION_5,
  "claude-mythos-5-1": NEWEST,
  "claude-mythos-5": GENERATION_5,
  "claude-opus-5-5": NEWEST,
  "claude-sonnet-5-5": { ...NEWEST, minimalThinking: "between_tools" },
  "claude-opus-5": GENERATION_5,
  "claude-sonnet-5": GENERATION_5,
  "claude-opus-4-8": { ...ADAPTIVE_4, supportsOutputFormat: true, acceptsSamplingParams: false },
  "claude-opus-4-7": { ...ADAPTIVE_4, acceptsSamplingParams: false },
  "claude-opus-4-6": ADAPTIVE_4,
  "claude-opus-4-5": { ...BUDGET, supportsOutputFormat: true },
  "claude-opus-4-1": { ...BUDGET, supportsOutputFormat: true },
  "claude-haiku-4-5": { ...BUDGET, supportsOutputFormat: true },
  "claude-sonnet-4-6": ADAPTIVE_4,
  "claude-sonnet-4-5": BUDGET,
  "claude-3-7-sonnet": BUDGET,
  "claude-3-5-sonnet": PRE_THINKING,
  "claude-3-5-haiku": PRE_THINKING,
  "claude-3-haiku": PRE_THINKING,
  "claude-3-opus": PRE_THINKING,
};

/** Rows for models `ANTHROPIC_PRICING` has no card for; the contract test allows exactly these. */
export const ANTHROPIC_UNPRICED_PROFILE_IDS: ReadonlySet<string> = new Set([
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-opus-4-5",
  "claude-opus-4-1",
]);

/** Families the profile table names; any other family is not guessed at. */
const KNOWN_FAMILIES: ReadonlySet<string> = new Set(["fable", "mythos", "opus", "sonnet", "haiku"]);
/** Newest generation the table has rows for. */
const LATEST_KNOWN_MAJOR = 5;
/** Generation 4 took sampling parameters through this minor, and adaptive thinking from this one. */
const LAST_SAMPLING_MINOR_4 = 6;
const FIRST_ADAPTIVE_MINOR_4 = 6;
/** Extended thinking arrived in Claude 3.7. */
const FIRST_THINKING_MINOR_3 = 7;

/**
 * The one answer for an id with no row, and the only place that guesses.
 * - An id the parser cannot read gets {@link UNREADABLE}, and is not recognized.
 * - A generation at or beyond the newest known gets the newest known profile,
 *   on the assumption a future model behaves as the latest one does. It is
 *   recognized when its family is one the table names, so request building
 *   and capability inference agree on what the model is.
 * - An older generation is graded on the rules each generation shipped under.
 */
function defaultAnthropicProfile(canonicalId: string): {
  readonly profile: AnthropicModelProfile;
  readonly recognized: boolean;
} {
  const parsed = parseAnthropicModelId(canonicalId);
  if (parsed === undefined) return { profile: UNREADABLE, recognized: false };
  const { major, family } = parsed;
  if (major >= LATEST_KNOWN_MAJOR)
    return { profile: NEWEST, recognized: KNOWN_FAMILIES.has(family) };
  if (major === 4) {
    // A missing minor is generation `.0` (`claude-sonnet-4-20250514`).
    const minor = parsed.minor ?? 0;
    const profile = minor >= FIRST_ADAPTIVE_MINOR_4 ? ADAPTIVE_4 : BUDGET;
    return {
      profile: { ...profile, acceptsSamplingParams: minor <= LAST_SAMPLING_MINOR_4 },
      recognized: KNOWN_FAMILIES.has(family),
    };
  }
  if (major === 3) {
    const thinks = (parsed.minor ?? 0) >= FIRST_THINKING_MINOR_3;
    return { profile: thinks ? BUDGET : PRE_THINKING, recognized: true };
  }
  return { profile: PRE_VISION, recognized: major === 2 };
}

export type AnthropicResolvedProfile = ResolvedModelProfile<AnthropicModelProfile>;

export const resolveAnthropicProfile: (modelName: string | undefined) => AnthropicResolvedProfile =
  makeModelProfileResolver({
    models: ANTHROPIC_MODEL_PROFILES,
    normalize: normalizeAnthropicModelId,
    fallback: defaultAnthropicProfile,
  });

const TEXT_CAPABILITIES = [
  "text.generation",
  "text.rewriter",
  "text.summary",
  "tool-use",
  "json-mode",
] as const satisfies Capability[];
const META_CAPABILITIES = [
  "model.count-tokens",
  "model.info",
  "model.search",
] as const satisfies Capability[];

/** The task capabilities a profile serves. */
export function anthropicProfileCapabilities(
  profile: AnthropicModelProfile
): readonly Capability[] {
  return [
    ...TEXT_CAPABILITIES,
    ...(profile.vision ? (["vision-input"] as const) : []),
    ...(profile.promptCaching ? (["cache.checkpoint"] as const) : []),
    ...META_CAPABILITIES,
  ];
}
