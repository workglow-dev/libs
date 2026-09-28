/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util/worker";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";

/**
 * Highest Claude generation that still accepts `temperature` / `top_p`.
 * Newer generations reject them with HTTP 400, which maps to a
 * non-retryable `PermanentJobError`.
 */
export const ANTHROPIC_LAST_SAMPLING_MAJOR = 4;
/** Highest minor within {@link ANTHROPIC_LAST_SAMPLING_MAJOR} that accepts them. */
export const ANTHROPIC_LAST_SAMPLING_MINOR = 6;

/**
 * A numeric id segment this long is a release date (`20250514`), not a minor
 * version. Without this rule `claude-sonnet-4-20250514` parses as minor
 * 20250514 and is wrongly treated as a post-cutoff generation.
 */
const DATE_SEGMENT = /^\d{6,}$/;
const NUMERIC_SEGMENT = /^\d+$/;
const CLAUDE_PREFIX = "claude-";
/** Families that never accepted sampling parameters, whatever their version. */
const REJECTED_FAMILY = /^claude-(?:fable|mythos)(?:$|[-.])/;

/**
 * Gateways prefix the vendor onto the id (`us.anthropic.claude-…`,
 * `anthropic.claude-…`) and suffix a revision (`…-v1:0`). Stripping the prefix
 * grades those spellings on the same generation rule as a native id, instead of
 * having them fall out of the parser as "not a Claude id at all".
 */
export const ANTHROPIC_GATEWAY_PREFIX = /^(?:[a-z0-9-]+\.)*anthropic\./i;

interface ParsedAnthropicModelId {
  /** Empty for the bare `claude-2.1` shape, which carries no family name. */
  readonly family: string;
  readonly major: number;
  readonly minor: number | undefined;
}

/**
 * Parses the three id shapes Anthropic has shipped:
 * - modern `claude-<family>-<major>[-<minor>][-<date>]` (`claude-opus-4-8`)
 * - legacy `claude-<major>[-<minor>]-<family>[-<date>]` (`claude-3-5-sonnet-20241022`)
 * - bare `claude-[instant-]<major>[.<minor>]` (`claude-2.1`, `claude-instant-1.2`)
 *
 * Returns `undefined` for anything else, including non-Claude ids.
 */
export function parseAnthropicModelId(id: string): ParsedAnthropicModelId | undefined {
  const normalized = id.trim().toLowerCase();
  if (!normalized.startsWith(CLAUDE_PREFIX)) return undefined;

  let rest = normalized.slice(CLAUDE_PREFIX.length);
  if (rest.length === 0) return undefined;

  if (rest.startsWith("instant-")) rest = rest.slice("instant-".length);
  const bare = /^(\d+)(?:\.(\d+))?$/.exec(rest);
  if (bare) {
    return {
      family: "",
      major: Number(bare[1]),
      minor: bare[2] === undefined ? undefined : Number(bare[2]),
    };
  }

  const segments = rest.split("-").filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;

  const isVersionSegment = (segment: string | undefined): boolean =>
    segment !== undefined && NUMERIC_SEGMENT.test(segment) && !DATE_SEGMENT.test(segment);

  // Legacy shape leads with the version: claude-3-5-sonnet-20241022.
  if (isVersionSegment(segments[0])) {
    const major = Number(segments[0]);
    let index = 1;
    let minor: number | undefined;
    if (isVersionSegment(segments[index])) {
      minor = Number(segments[index]);
      index += 1;
    }
    const family = segments[index];
    if (family === undefined || NUMERIC_SEGMENT.test(family)) return undefined;
    return { family, major, minor };
  }

  // Modern shape leads with the family: claude-opus-4-8.
  if (!isVersionSegment(segments[1])) return undefined;
  return {
    family: segments[0]!,
    major: Number(segments[1]),
    minor: isVersionSegment(segments[2]) ? Number(segments[2]) : undefined,
  };
}

interface AnthropicSamplingProviderConfig {
  readonly model_name?: string;
  readonly sampling_params?: "send" | "omit";
}

/**
 * Whether the configured model accepts `temperature` / `top_p`.
 *
 * This is an allow-list of generations known to accept them, not a deny-list
 * of the ones that reject them: an id that does not match a known-accepting
 * shape is treated as rejecting. A wrong `false` changes sampling behavior; a
 * wrong `true` is an unrecoverable 400, so an unrecognized id defaults to
 * omitting. `provider_config.sampling_params` overrides the decision either way.
 */
export function anthropicAcceptsSamplingParams(model: AnthropicModelConfig | undefined): boolean {
  const config = model?.provider_config as AnthropicSamplingProviderConfig | undefined;

  const override = config?.sampling_params;
  if (override === "send") return true;
  if (override === "omit") return false;

  const id = (config?.model_name ?? "").trim().toLowerCase();
  if (REJECTED_FAMILY.test(id)) return false;

  const parsed = parseAnthropicModelId(id);
  if (parsed === undefined) return false;
  if (parsed.major > ANTHROPIC_LAST_SAMPLING_MAJOR) return false;
  // A missing minor means generation `.0` (e.g. `claude-sonnet-4-20250514`),
  // which predates the cutoff — deliberately permissive.
  if (
    parsed.major === ANTHROPIC_LAST_SAMPLING_MAJOR &&
    parsed.minor !== undefined &&
    parsed.minor > ANTHROPIC_LAST_SAMPLING_MINOR
  ) {
    return false;
  }
  return true;
}

interface AnthropicSamplingInput {
  readonly temperature?: number;
  readonly topP?: number;
}

/**
 * Extended thinking bounds `top_p` rather than forbidding it: the API rejects
 * anything below this with a 400 and accepts everything at or above it, so a
 * value in range is worth passing through instead of discarding.
 */
const THINKING_MIN_TOP_P = 0.95;

/**
 * Copies the caller's sampling fields onto an Anthropic request body when the
 * model accepts them. On a rejecting model the keys are left absent (rather
 * than set to `undefined`) and a single warning names everything dropped, so
 * the user's setting becoming a no-op is visible without failing the request.
 *
 * Call this after {@link applyAnthropicThinkingParams}: whether the request
 * carries extended thinking decides whether sampling is legal at all.
 */
export function applyAnthropicSamplingParams(
  params: Record<string, unknown>,
  input: AnthropicSamplingInput,
  model: AnthropicModelConfig | undefined
): void {
  const supplied: Array<readonly [wireName: string, value: number]> = [];
  if (input.temperature !== undefined) supplied.push(["temperature", input.temperature]);
  if (input.topP !== undefined) supplied.push(["top_p", input.topP]);
  if (supplied.length === 0) return;

  // Extended thinking (`thinking.type = "enabled"`) narrows sampling rather
  // than forbidding it, so an in-range `top_p` is passed through instead of
  // discarded. `temperature` is always dropped: its only legal value under
  // thinking is the default `1`, so sending it can never change the result,
  // and omitting it also keeps the request clear of the separate rule that
  // `temperature` and `top_p` may not both be specified. Scoped to "enabled"
  // on purpose: `{type:"adaptive"}` on 4.6+ is the recommended configuration
  // and accepts the full range. Requires that thinking has already been merged
  // onto `params`.
  const thinking = params.thinking as { type?: string } | undefined;
  let permitted = supplied;
  if (thinking?.type === "enabled") {
    const dropped: string[] = [];
    permitted = supplied.filter(([wireName, value]) => {
      if (wireName === "top_p" && value >= THINKING_MIN_TOP_P) return true;
      dropped.push(wireName);
      return false;
    });
    if (dropped.length > 0) {
      getLogger().warn(
        "Anthropic extended thinking constrains sampling; dropping unsupported parameters.",
        {
          model: model?.provider_config?.model_name ?? "",
          dropped,
        }
      );
    }
    if (permitted.length === 0) return;
  }

  if (anthropicAcceptsSamplingParams(model)) {
    for (const [wireName, value] of permitted) params[wireName] = value;
    return;
  }

  getLogger().warn("Anthropic model rejects sampling parameters; dropping them.", {
    model: model?.provider_config?.model_name ?? "",
    dropped: permitted.map(([wireName]) => wireName),
  });
}

function parsedModelName(model: AnthropicModelConfig | undefined) {
  const id = (model?.provider_config as { model_name?: string } | undefined)?.model_name ?? "";
  return parseAnthropicModelId(id.trim().replace(ANTHROPIC_GATEWAY_PREFIX, ""));
}

/**
 * Whether the configured model accepts a forced `tool_choice` (`any` or
 * `tool`). Claude Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 reject both
 * with a 400, and later generations are assumed to follow them: a wrong `false`
 * only relaxes the choice to `auto`, a wrong `true` is an unrecoverable 400.
 * An id the parser cannot read keeps the forced choice, as before.
 */
export function anthropicAcceptsForcedToolChoice(model: AnthropicModelConfig | undefined): boolean {
  const parsed = parsedModelName(model);
  if (parsed === undefined) return true;
  if (parsed.major < 5) return true;
  if (parsed.major > 5) return false;
  const minor = parsed.minor ?? 0;
  switch (parsed.family) {
    case "fable":
    case "mythos":
      return minor < 1;
    case "opus":
    case "sonnet":
      return minor < 5;
    default:
      return false;
  }
}

/**
 * Request fields that come closest to "no thinking" on a Claude 5+ model, where
 * omitting `thinking` still runs adaptive thinking at the model's default
 * effort. Sonnet 5.5 has a real off switch (`between_tools`); every other
 * generation-5 model is held to `low` effort, which Anthropic recommends over
 * `{type: "disabled"}` even where that is still accepted. Returns `undefined`
 * for models where omitting thinking already means none.
 */
export function anthropicMinimalThinkingParams(
  model: AnthropicModelConfig | undefined
):
  | { readonly thinking: { readonly type: "between_tools" } }
  | { readonly output_config: { readonly effort: "low" } }
  | undefined {
  const parsed = parsedModelName(model);
  if (parsed === undefined || parsed.major < 5) return undefined;
  if (parsed.family === "sonnet" && parsed.major === 5 && (parsed.minor ?? 0) >= 5) {
    return { thinking: { type: "between_tools" } };
  }
  return { output_config: { effort: "low" } };
}
