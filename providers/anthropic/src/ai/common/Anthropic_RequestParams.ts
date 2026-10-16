/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util/worker";
import { normalizeAnthropicModelId, parseAnthropicModelId } from "./Anthropic_ModelId";
import { resolveAnthropicProfile } from "./Anthropic_ModelProfiles";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";

/**
 * Highest Claude generation that still accepts `temperature` / `top_p`.
 * Newer generations reject them with HTTP 400, which maps to a
 * non-retryable `PermanentJobError`.
 */
export const ANTHROPIC_LAST_SAMPLING_MAJOR = 4;
/** Highest minor within {@link ANTHROPIC_LAST_SAMPLING_MAJOR} that accepts them. */
export const ANTHROPIC_LAST_SAMPLING_MINOR = 6;

/** Families that never accepted sampling parameters, whatever their version. */
const REJECTED_FAMILY = /^claude-(?:fable|mythos)(?:$|[-.])/;

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

export function modelNameOf(model: AnthropicModelConfig | undefined): string {
  return (model?.provider_config as { model_name?: string } | undefined)?.model_name ?? "";
}

/** The configured model's id, parsed, with any cloud-gateway spelling reduced to the canonical one. */
export function parsedModelName(model: AnthropicModelConfig | undefined) {
  return parseAnthropicModelId(normalizeAnthropicModelId(modelNameOf(model)));
}

/** Where a capability decision came from. `"default"` means no table entry covered the id. */
export type AnthropicCapabilitySource = "override" | "table" | "default";

export interface AnthropicCapabilityResolution {
  readonly value: boolean;
  readonly source: AnthropicCapabilitySource;
}

interface AnthropicCapabilityOverrides {
  readonly supports_output_format?: boolean;
  readonly accepts_forced_tool_choice?: boolean;
}

/** The record's explicit answer for a capability flag, when it carries one. */
export function anthropicCapabilityOverride(
  model: AnthropicModelConfig | undefined,
  flag: keyof AnthropicCapabilityOverrides
): AnthropicCapabilityResolution | undefined {
  const value = (model?.provider_config as AnthropicCapabilityOverrides | undefined)?.[flag];
  return typeof value === "boolean" ? { value, source: "override" } : undefined;
}

/**
 * Whether the configured model accepts a forced `tool_choice` (`any` or
 * `tool`), and how that was decided. `provider_config.accepts_forced_tool_choice`
 * overrides everything; otherwise the model's row in `ANTHROPIC_MODEL_PROFILES`
 * answers, and an id with no row takes the documented default profile there.
 */
export function resolveAnthropicForcedToolChoice(
  model: AnthropicModelConfig | undefined
): AnthropicCapabilityResolution {
  const override = anthropicCapabilityOverride(model, "accepts_forced_tool_choice");
  if (override !== undefined) return override;
  const { profile, source } = resolveAnthropicProfile(modelNameOf(model));
  return { value: profile.acceptsForcedToolChoice, source };
}

export function anthropicAcceptsForcedToolChoice(model: AnthropicModelConfig | undefined): boolean {
  return resolveAnthropicForcedToolChoice(model).value;
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

/**
 * Request fields for a Claude 5+ model when no effort or thinking is
 * configured: adaptive thinking at the model's own default effort. The API
 * already runs adaptive when `thinking` is omitted on these models; sending it
 * says so on the wire instead of depending on that default. Returns
 * `undefined` for earlier generations, where omitting thinking means none.
 */
export function anthropicDefaultThinkingParams(
  model: AnthropicModelConfig | undefined
): { readonly thinking: { readonly type: "adaptive" } } | undefined {
  const parsed = parsedModelName(model);
  if (parsed === undefined || parsed.major < 5) return undefined;
  return { thinking: { type: "adaptive" } };
}
