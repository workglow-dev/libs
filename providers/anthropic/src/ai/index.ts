/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export { ANTHROPIC_ALLOWED_HOSTS } from "./common/Anthropic_Client";
export * from "./common/Anthropic_Constants";
export { anthropicEffortPolicy } from "./common/Anthropic_EffortPolicy";
export * from "./common/Anthropic_ModelSchema";
export * from "./common/Anthropic_ModelSearch";
export * from "./common/Anthropic_Pricing";
export * from "./registerAnthropic";

import { AnthropicQueuedProvider } from "./AnthropicQueuedProvider";
import { ANTHROPIC_RUN_FN_SPECS } from "./common/Anthropic_Capabilities";
import { _testOnly as clientTestOnly } from "./common/Anthropic_Client";
import { ANTHROPIC_RUN_FNS } from "./common/Anthropic_JobRunFns";
import {
  anthropicSupportsOutputFormat,
  toAnthropicOutputSchema,
} from "./common/Anthropic_OutputFormat";
import { maybeEmitAnthropicRefusal } from "./common/Anthropic_Refusal";
import {
  anthropicAcceptsForcedToolChoice,
  anthropicAcceptsSamplingParams,
  applyAnthropicSamplingParams,
} from "./common/Anthropic_RequestParams";
import {
  anthropicSupportsAdaptiveThinking,
  applyAnthropicThinkingParams,
  buildAnthropicThinkingParams,
} from "./common/Anthropic_Thinking";
import { createAnthropicUsageCollector, mapAnthropicUsage } from "./common/Anthropic_Usage";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  AnthropicQueuedProvider,
  ANTHROPIC_RUN_FN_SPECS,
  ANTHROPIC_RUN_FNS,
  maybeEmitAnthropicRefusal,
  anthropicAcceptsForcedToolChoice,
  anthropicSupportsOutputFormat,
  toAnthropicOutputSchema,
  anthropicAcceptsSamplingParams,
  applyAnthropicSamplingParams,
  anthropicSupportsAdaptiveThinking,
  applyAnthropicThinkingParams,
  buildAnthropicThinkingParams,
  setAnthropicClientForTests: clientTestOnly.setAnthropicClientForTests,
  createAnthropicUsageCollector,
  mapAnthropicUsage,
} as const;
