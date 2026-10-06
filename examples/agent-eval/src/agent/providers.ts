/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerAnthropicInline } from "@workglow/anthropic/ai-runtime";
import { registerDeepSeekInline } from "@workglow/deepseek/ai-runtime";
import { registerGeminiInline } from "@workglow/google-gemini/ai-runtime";
import { registerOpenAiInline } from "@workglow/openai/ai-runtime";
import { registerOpenRouterInline } from "@workglow/openrouter/ai-runtime";
import { EnvCredentialStore, setGlobalCredentialStore } from "@workglow/util";
import { registerXaiInline } from "@workglow/xai/ai-runtime";

const REGISTRATIONS: Readonly<Record<string, () => Promise<void>>> = {
  ANTHROPIC: () => registerAnthropicInline(),
  OPENAI: () => registerOpenAiInline(),
  GOOGLE_GEMINI: () => registerGeminiInline(),
  DEEPSEEK: () => registerDeepSeekInline(),
  XAI: () => registerXaiInline(),
  OPENROUTER: () => registerOpenRouterInline(),
};

/**
 * Registers the one provider a run needs, in process. Keys come from the
 * environment, as every harness in the comparison reads them.
 */
export async function registerAgentProvider(provider: string): Promise<void> {
  setGlobalCredentialStore(new EnvCredentialStore());
  const register = REGISTRATIONS[provider];
  if (register === undefined) throw new Error(`no registration for provider ${provider}`);
  await register();
}
