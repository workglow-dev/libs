/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig, ModelEffort } from "@workglow/ai";
import { isModelEffort } from "@workglow/ai";
import { getAnthropicModelPricing } from "@workglow/anthropic/ai";
import { getDeepSeekModelPricing } from "@workglow/deepseek/ai";
import { getGeminiModelPricing } from "@workglow/google-gemini/ai";
import { getOpenAiModelPricing } from "@workglow/openai/ai";
import { getXaiModelPricing } from "@workglow/xai/ai";

interface ProviderSpec {
  readonly provider: string;
  /** Environment variables naming a custom endpoint, first set wins. */
  readonly baseUrlEnvs: readonly string[];
  readonly pricing?: ((model: string) => ModelConfig["pricing"]) | undefined;
}

/**
 * Provider prefixes as opencode, pi and Harbor spell them, so one `--model`
 * string means the same model to all three harnesses.
 */
const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  anthropic: {
    provider: "ANTHROPIC",
    baseUrlEnvs: ["ANTHROPIC_BASE_URL"],
    pricing: getAnthropicModelPricing,
  },
  openai: {
    provider: "OPENAI",
    baseUrlEnvs: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    pricing: getOpenAiModelPricing,
  },
  google: { provider: "GOOGLE_GEMINI", baseUrlEnvs: [], pricing: getGeminiModelPricing },
  gemini: { provider: "GOOGLE_GEMINI", baseUrlEnvs: [], pricing: getGeminiModelPricing },
  deepseek: {
    provider: "DEEPSEEK",
    baseUrlEnvs: ["DEEPSEEK_BASE_URL"],
    pricing: getDeepSeekModelPricing,
  },
  xai: { provider: "XAI", baseUrlEnvs: ["XAI_BASE_URL"], pricing: getXaiModelPricing },
  openrouter: { provider: "OPENROUTER", baseUrlEnvs: ["OPENROUTER_BASE_URL"] },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

/**
 * Reasoning levels as pi and opencode name them, mapped onto the coarse
 * {@link ModelEffort} dial, so a run configured for one harness reads the same
 * here.
 */
const EFFORT_ALIASES: Readonly<Record<string, ModelEffort>> = {
  off: "none",
  minimal: "low",
  xhigh: "extra",
  max: "ultra",
};

export function parseEffort(value: string | undefined): ModelEffort | undefined {
  if (value === undefined || value === "") return undefined;
  const effort = EFFORT_ALIASES[value] ?? value;
  if (!isModelEffort(effort)) {
    throw new Error(
      `unknown effort "${value}" — use none|low|medium|high|extra|ultra (or off|minimal|xhigh|max)`
    );
  }
  return effort;
}

/**
 * `provider/model` (Harbor's `-m`) to an inline {@link ModelConfig}. A custom
 * endpoint in the provider's `*_BASE_URL` variable is trusted: the operator set
 * it for this run, which is the case the allow-list exists to make explicit.
 */
export function resolveAgentModel(
  id: string,
  options: { readonly effort?: ModelEffort | undefined; readonly env?: NodeJS.ProcessEnv } = {}
): ModelConfig {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error(`model must be provider/model (e.g. anthropic/claude-sonnet-4-5), got "${id}"`);
  }
  const prefix = id.slice(0, slash).toLowerCase();
  const model = id.slice(slash + 1);
  const spec = PROVIDERS[prefix];
  if (spec === undefined) {
    throw new Error(
      `unsupported provider "${prefix}" — use one of ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }
  const env = options.env ?? process.env;
  const baseUrl = spec.baseUrlEnvs.map((name) => env[name]).find((value) => !!value);
  const pricing = spec.pricing?.(model);
  return {
    provider: spec.provider,
    provider_config: {
      model_name: model,
      ...(baseUrl ? { base_url: baseUrl, trustedBaseUrl: true } : {}),
    },
    ...(pricing ? { pricing } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  } as ModelConfig;
}
