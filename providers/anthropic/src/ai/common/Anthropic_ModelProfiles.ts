/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai/worker";
import { normalizeAnthropicModelId, parseAnthropicModelId } from "./Anthropic_ModelId";

/**
 * What differs per Claude model. Request building, capability inference and
 * the contract test all read this one shape, so a flag cannot be decided one
 * way where a request is built and another where a model is listed.
 */
export interface AnthropicModelProfile {
  /** Accepts `output_config.format`. A wrong `true` is an unrecoverable 400. */
  readonly supportsOutputFormat: boolean;
  /** Accepts a forced `tool_choice` (`any` or `tool`). A wrong `true` is an unrecoverable 400. */
  readonly acceptsForcedToolChoice: boolean;
  /** Takes image input. */
  readonly vision: boolean;
}

const profile = (
  supportsOutputFormat: boolean,
  acceptsForcedToolChoice: boolean,
  vision = true
): AnthropicModelProfile => ({ supportsOutputFormat, acceptsForcedToolChoice, vision });

/** Native output format, forced tool choice rejected: the newest known generation's behavior. */
const NEWEST = profile(true, false);
/** Native output format and forced tool choice both accepted. */
const NATIVE_AND_FORCED = profile(true, true);
/** Tool route for structured output, forced tool choice accepted: the pre-generation-5 behavior. */
const LEGACY = profile(false, true);

/**
 * One row per canonical id (see {@link normalizeAnthropicModelId}): adding a
 * model is a row here plus its price in `ANTHROPIC_PRICING`, and the contract
 * test fails until both exist. The unpriced rows are ids whose behavior differs
 * from what {@link defaultAnthropicProfile} would answer for them.
 */
export const ANTHROPIC_MODEL_PROFILES: Readonly<Record<string, AnthropicModelProfile>> = {
  "claude-fable-5-1": NEWEST,
  "claude-fable-5": NATIVE_AND_FORCED,
  "claude-mythos-5-1": NEWEST,
  "claude-mythos-5": NATIVE_AND_FORCED,
  "claude-opus-5-5": NEWEST,
  "claude-sonnet-5-5": NEWEST,
  "claude-opus-5": NATIVE_AND_FORCED,
  "claude-sonnet-5": NATIVE_AND_FORCED,
  "claude-opus-4-8": NATIVE_AND_FORCED,
  "claude-opus-4-7": LEGACY,
  "claude-opus-4-6": LEGACY,
  "claude-opus-4-5": NATIVE_AND_FORCED,
  "claude-opus-4-1": NATIVE_AND_FORCED,
  "claude-haiku-4-5": NATIVE_AND_FORCED,
  "claude-sonnet-4-6": LEGACY,
  "claude-sonnet-4-5": LEGACY,
  "claude-3-7-sonnet": LEGACY,
  "claude-3-5-sonnet": LEGACY,
  "claude-3-5-haiku": LEGACY,
  "claude-3-haiku": LEGACY,
  "claude-3-opus": LEGACY,
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

export type AnthropicProfileSource = "table" | "default";

export interface AnthropicResolvedProfile {
  readonly profile: AnthropicModelProfile;
  readonly source: AnthropicProfileSource;
  /**
   * Whether the id is one this package recognizes as a Claude model at all.
   * Capability inference answers only for these; the rest keep what the record declared.
   */
  readonly recognized: boolean;
}

/**
 * The one answer for an id with no row, and the only place that guesses.
 * - An id the parser cannot read gets the legacy profile: a wrong `false` costs
 *   only the older route, a wrong `true` is a 400.
 * - A generation beyond the newest known, or a generation-5 id with a family the
 *   table does not name, gets the newest known profile, on the assumption a
 *   future model behaves as the latest one does.
 * - Anything older gets the legacy profile.
 */
function defaultAnthropicProfile(canonicalId: string): {
  readonly profile: AnthropicModelProfile;
  readonly recognized: boolean;
} {
  const parsed = parseAnthropicModelId(canonicalId);
  if (parsed === undefined) return { profile: LEGACY, recognized: false };
  if (parsed.major >= LATEST_KNOWN_MAJOR) {
    return {
      profile: NEWEST,
      recognized: parsed.major === LATEST_KNOWN_MAJOR && KNOWN_FAMILIES.has(parsed.family),
    };
  }
  const recognized =
    parsed.major === 3 ||
    (parsed.major === 4 && ["opus", "sonnet", "haiku"].includes(parsed.family)) ||
    parsed.major === 2;
  // Claude 2 predates image input.
  return { profile: parsed.major === 2 ? profile(false, true, false) : LEGACY, recognized };
}

export function resolveAnthropicProfile(modelName: string | undefined): AnthropicResolvedProfile {
  const id = normalizeAnthropicModelId(modelName ?? "");
  if (Object.hasOwn(ANTHROPIC_MODEL_PROFILES, id)) {
    return { profile: ANTHROPIC_MODEL_PROFILES[id]!, source: "table", recognized: true };
  }
  return { ...defaultAnthropicProfile(id), source: "default" };
}

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

/** The task capabilities a profile serves; vision and cache checkpoints come with it. */
export function anthropicProfileCapabilities(
  profile: AnthropicModelProfile
): readonly Capability[] {
  return [
    ...TEXT_CAPABILITIES,
    // Claude 2 has neither image input nor prompt caching; every later model has both.
    ...(profile.vision ? (["vision-input", "cache.checkpoint"] as const) : []),
    ...META_CAPABILITIES,
  ];
}
