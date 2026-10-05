/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveEnabledEffort, type ModelEffort } from "@workglow/ai/worker";
import { getLogger } from "@workglow/util/worker";
import { anthropicEffortPolicy } from "./Anthropic_EffortPolicy";
import { normalizeAnthropicModelId, parseAnthropicModelId } from "./Anthropic_ModelId";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import {
  anthropicDefaultThinkingParams,
  anthropicMinimalThinkingParams,
} from "./Anthropic_RequestParams";

/** Token budgets for legacy `thinking.type = "enabled"` (and adaptive headroom). */
const EFFORT_TO_BUDGET: Record<ModelEffort, number> = {
  none: 0,
  low: 512,
  medium: 1024,
  high: 2048,
  extra: 4096,
  ultra: 8192,
};

/**
 * Anthropic rejects `thinking.budget_tokens` below 1024 with a 400. The coarse
 * `low` effort maps to 512, which is legal headroom on the adaptive path but
 * not a legal legacy budget.
 */
const MIN_LEGACY_THINKING_BUDGET = 1024;

/** Maps coarse effort onto Anthropic adaptive `output_config.effort`. */
const EFFORT_TO_ADAPTIVE: Record<Exclude<ModelEffort, "none">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  ultra: "max",
};

interface AnthropicThinkingProviderConfig {
  readonly model_name?: string;
  readonly thinking?: Record<string, unknown>;
  readonly output_config?: { readonly effort?: string; readonly [key: string]: unknown };
}

export interface AnthropicThinkingParams {
  readonly thinking?: Record<string, unknown>;
  readonly output_config?: Record<string, unknown>;
  readonly max_tokens: number;
}

/**
 * Claude 4.6+ (and 5.x) accept adaptive thinking + `output_config.effort`.
 * Earlier thinking-capable ids use `thinking.type = "enabled"` + `budget_tokens`.
 * Unrecognized ids stay on the legacy path (safer than a 400 on adaptive).
 */
export function anthropicSupportsAdaptiveThinking(
  model: AnthropicModelConfig | undefined
): boolean {
  const id = (model?.provider_config as AnthropicThinkingProviderConfig | undefined)?.model_name;
  if (!id) return false;
  const parsed = parseAnthropicModelId(normalizeAnthropicModelId(id));
  if (parsed === undefined) return false;
  if (parsed.major > 4) return true;
  if (parsed.major < 4) return false;
  return (parsed.minor ?? 0) >= 6;
}

function padMaxTokens(maxTokens: number, budget: number): number {
  return budget > 0 ? maxTokens + budget : maxTokens;
}

/**
 * Builds Anthropic request thinking fields from native `provider_config` or
 * `model.effort`. Native `thinking` / `output_config.effort` always win.
 * Before Claude 5, an unset or `"none"` effort omits thinking fields. On Claude
 * 5+, an unset effort sends adaptive thinking with no effort (the model's
 * default), and an explicit `"none"` sends the minimal setting it accepts.
 */
export function buildAnthropicThinkingParams(
  model: AnthropicModelConfig | undefined,
  maxTokens: number
): AnthropicThinkingParams {
  const pc = model?.provider_config as AnthropicThinkingProviderConfig | undefined;
  const nativeThinking = pc?.thinking;
  const nativeEffort = pc?.output_config?.effort;

  if (nativeThinking !== undefined || nativeEffort !== undefined) {
    const result: {
      thinking?: Record<string, unknown>;
      output_config?: Record<string, unknown>;
      max_tokens: number;
    } = { max_tokens: maxTokens };
    if (nativeThinking !== undefined) result.thinking = { ...nativeThinking };
    if (pc?.output_config !== undefined) result.output_config = { ...pc.output_config };
    const budget =
      typeof nativeThinking?.budget_tokens === "number" ? nativeThinking.budget_tokens : 0;
    result.max_tokens = padMaxTokens(maxTokens, budget);
    return result;
  }

  const effort = resolveEnabledEffort(model, anthropicEffortPolicy(model));
  if (effort === undefined || effort === "none") {
    // Claude 5+ thinks when `thinking` is omitted, so an explicit "none" has to
    // be asked for, and an unset effort is sent as adaptive at the model's own
    // default effort.
    const fields =
      effort === "none" && model?.effort === "none"
        ? anthropicMinimalThinkingParams(model)
        : anthropicDefaultThinkingParams(model);
    return fields === undefined ? { max_tokens: maxTokens } : { ...fields, max_tokens: maxTokens };
  }

  const budget = EFFORT_TO_BUDGET[effort];

  if (anthropicSupportsAdaptiveThinking(model)) {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT_TO_ADAPTIVE[effort] },
      max_tokens: padMaxTokens(maxTokens, budget),
    };
  }

  const legacyBudget = Math.max(budget, MIN_LEGACY_THINKING_BUDGET);
  return {
    thinking: { type: "enabled", budget_tokens: legacyBudget },
    max_tokens: padMaxTokens(maxTokens, legacyBudget),
  };
}

/**
 * Merges thinking / output_config / padded max_tokens onto an Anthropic request
 * body. Call this after `tool_choice` is on `params` and before sampling params
 * — both of the guards below read what has already been built.
 */
export function applyAnthropicThinkingParams(
  params: Record<string, unknown>,
  model: AnthropicModelConfig | undefined
): void {
  if (typeof params.max_tokens !== "number") return;
  const built = buildAnthropicThinkingParams(model, params.max_tokens);

  // Legacy `thinking.type = "enabled"` cannot be combined with a forced tool
  // choice. `{type:"auto"}` is not forced, and the adaptive path is unaffected.
  // Testing the built result rather than the model version also covers a
  // native `provider_config.thinking`.
  const choice = params.tool_choice as { type?: string } | undefined;
  const forcedTool = choice?.type === "tool" || choice?.type === "any";
  if (forcedTool && (built.thinking as { type?: string } | undefined)?.type === "enabled") {
    getLogger().warn("Anthropic forced tool choice cannot carry extended thinking; skipping it.", {
      model: (model?.provider_config as AnthropicThinkingProviderConfig | undefined)?.model_name,
      tool_choice: choice?.type,
    });
    return;
  }

  params.max_tokens = built.max_tokens;
  if (built.thinking !== undefined) params.thinking = built.thinking;
  // Merged, not assigned: `output_config` also carries a structured-output
  // `format` set before this runs, which effort must not overwrite.
  if (built.output_config !== undefined) {
    params.output_config = {
      ...((params.output_config as Record<string, unknown> | undefined) ?? {}),
      ...built.output_config,
    };
  }
}
