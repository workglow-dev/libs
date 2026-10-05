/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export { OPENAI_ALLOWED_HOSTS } from "./common/OpenAI_Client";
export * from "./common/OpenAI_Constants";
export { openaiEffortPolicy } from "./common/OpenAI_EffortPolicy";
export * from "./common/OpenAI_ImageValidation";
export * from "./common/OpenAI_ModelSchema";
export * from "./common/OpenAI_ModelSearch";
export * from "./common/OpenAI_Pricing";
export * from "./registerOpenAi";

import { OPENAI_RUN_FN_SPECS } from "./common/OpenAI_Capabilities";
import {
  _testOnly as clientTestOnly,
  finalizeResponsesRequest,
  getReasoningConfig,
  resolvePromptCacheKey,
} from "./common/OpenAI_Client";
import { OPENAI_RUN_FNS } from "./common/OpenAI_JobRunFns";
import {
  _resetOpenAIResponsesWarnings,
  warnPenaltyDroppedOnce,
  warnStrictDowngradedOnce,
  warnTemperatureDroppedOnce,
} from "./common/OpenAI_ResponsesWarnings";
import { isStrictCompatibleSchema } from "./common/OpenAI_StructuredGeneration";
import { resolveOpenAiTemperatureWithReasoning } from "./common/OpenAI_TemperatureCapability";
import { OpenAiQueuedProvider } from "./OpenAiQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  OpenAiQueuedProvider,
  OPENAI_RUN_FN_SPECS,
  OPENAI_RUN_FNS,
  finalizeResponsesRequest,
  getReasoningConfig,
  resolvePromptCacheKey,
  resolveOpenAiTemperatureWithReasoning,
  isStrictCompatibleSchema,
  warnPenaltyDroppedOnce,
  warnStrictDowngradedOnce,
  warnTemperatureDroppedOnce,
  _resetOpenAIResponsesWarnings,
  setOpenAIClientForTests: clientTestOnly.setOpenAIClientForTests,
} as const;
