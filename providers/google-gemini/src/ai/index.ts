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

import { GEMINI_RUN_FN_SPECS, inferGeminiCapabilities } from "./common/Gemini_Capabilities";
import {
  generateGeminiStreamWithCacheFallback,
  isGeminiCachedContentNotFoundError,
} from "./common/Gemini_CachedContentFallback";
import {
  _testOnly as clientTestOnly,
  geminiReturnsThoughts,
  geminiSupportsMultimodalFunctionResponses,
  resolveThinkingConfig,
} from "./common/Gemini_Client";
import {
  _cacheStoreTestOnly,
  getGeminiCachedContent,
  setGeminiCachedContent,
} from "./common/Gemini_CacheStore";
import { GEMINI_RUN_FNS } from "./common/Gemini_JobRunFns";
import {
  GEMINI_MODEL_PROFILES,
  GEMINI_UNPRICED_PROFILE_IDS,
  geminiProfileCapabilities,
  normalizeGeminiModelId,
  resolveGeminiProfile,
} from "./common/Gemini_ModelProfiles";
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
  GEMINI_MODEL_PROFILES,
  GEMINI_UNPRICED_PROFILE_IDS,
  normalizeGeminiModelId,
  resolveGeminiProfile,
  geminiProfileCapabilities,
  inferGeminiCapabilities,
  buildGeminiContents,
  geminiSupportsMultimodalFunctionResponses,
  geminiReturnsThoughts,
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
