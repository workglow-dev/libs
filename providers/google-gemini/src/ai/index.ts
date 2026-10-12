/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./common/Gemini_Constants";
export { geminiEffortPolicy } from "./common/Gemini_EffortPolicy";
export * from "./common/Gemini_ImageValidation";
export * from "./common/Gemini_ModelSchema";
export * from "./common/Gemini_ModelSearch";
export * from "./common/Gemini_Pricing";
export * from "./registerGemini";

import { GEMINI_RUN_FN_SPECS } from "./common/Gemini_Capabilities";
import {
  generateGeminiStreamWithCacheFallback,
  isGeminiCachedContentNotFoundError,
} from "./common/Gemini_CachedContentFallback";
import {
  _testOnly as clientTestOnly,
  geminiSupportsMultimodalFunctionResponses,
  resolveThinkingConfig,
} from "./common/Gemini_Client";
import {
  _cacheStoreTestOnly,
  getGeminiCachedContent,
  setGeminiCachedContent,
} from "./common/Gemini_CacheStore";
import { GEMINI_RUN_FNS } from "./common/Gemini_JobRunFns";
import { emitGeminiRefusal, geminiRefusalCategory } from "./common/Gemini_Refusal";
import { buildGeminiContents } from "./common/Gemini_ToolCalling";
import { mapGeminiUsage } from "./common/Gemini_Usage";
import { GoogleGeminiQueuedProvider } from "./GoogleGeminiQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API. The cache-store helpers are re-exported off this barrel
 * (in addition to `ai-runtime`) so tests that drive the ai-bundle run-fns can
 * seed / read the same runtime-local map the run-fns look at.
 */
export const _testOnly = {
  GoogleGeminiQueuedProvider,
  GEMINI_RUN_FN_SPECS,
  GEMINI_RUN_FNS,
  buildGeminiContents,
  geminiSupportsMultimodalFunctionResponses,
  geminiRefusalCategory,
  emitGeminiRefusal,
  setGeminiClientForTests: clientTestOnly.setGeminiClientForTests,
  setGeminiCachedContent,
  getGeminiCachedContent,
  cacheStoreTestOnly: _cacheStoreTestOnly,
  isGeminiCachedContentNotFoundError,
  generateGeminiStreamWithCacheFallback,
  mapGeminiUsage,
  resolveThinkingConfig,
} as const;
