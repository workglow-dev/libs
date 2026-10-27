/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";

export interface ProviderChoice {
  readonly id: string;
  readonly provider: string;
  readonly defaultModel: string;
  /** Loaded on demand so a page pays for the one SDK it uses. */
  register(): Promise<void>;
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    id: "anthropic",
    provider: "ANTHROPIC",
    defaultModel: "claude-sonnet-5-5",
    register: async () =>
      (await import("@workglow/anthropic/ai-runtime")).registerAnthropicInline(),
  },
  {
    id: "openai",
    provider: "OPENAI",
    defaultModel: "gpt-5",
    register: async () => (await import("@workglow/openai/ai-runtime")).registerOpenAiInline(),
  },
  {
    id: "google",
    provider: "GOOGLE_GEMINI",
    defaultModel: "gemini-2.5-pro",
    register: async () =>
      (await import("@workglow/google-gemini/ai-runtime")).registerGeminiInline(),
  },
];

/**
 * The key goes in the model config and from there straight to the provider's
 * SDK call from this tab. It is never written to storage, and it is never
 * visible to code running in the sandbox, which has no access to the page.
 */
export function buildModelConfig(
  choice: ProviderChoice,
  model: string,
  apiKey: string
): ModelConfig {
  return {
    provider: choice.provider,
    provider_config: { model_name: model, api_key: apiKey },
  } as ModelConfig;
}
