/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderPreviewRunFn, AiProviderRunFnRegistration } from "@workglow/ai";
import {
  META_COUNT_TOKENS,
  META_JSON_MODE,
  META_MODEL_INFO,
  META_MODEL_SEARCH,
  META_TEXT_GENERATION,
  META_TEXT_REWRITER,
  META_TEXT_SUMMARY,
  META_TOOL_USE,
} from "./Meta_CapabilitySets";
import type { MetaModelConfig } from "./Meta_ModelSchema";

export { getClient, getModelName, loadOpenAISDK } from "./Meta_Client";

import { Meta_CountTokens_Preview, Meta_CountTokens_Stream } from "./Meta_CountTokens.browser";
import { Meta_ModelInfo_Stream } from "./Meta_ModelInfo";
import { Meta_ModelSearch_Stream } from "./Meta_ModelSearch";
import { Meta_StructuredGeneration_Stream } from "./Meta_StructuredGeneration";
import { Meta_TextGeneration_Stream } from "./Meta_TextGeneration";
import { Meta_TextRewriter_Stream } from "./Meta_TextRewriter";
import { Meta_TextSummary_Stream } from "./Meta_TextSummary";
import { Meta_ToolCalling_Stream } from "./Meta_ToolCalling";

/**
 * Browser build of {@link META_RUN_FNS}. Identical to the node build except for
 * the count-tokens import (uses `js-tiktoken` rather than the WASM `tiktoken`
 * package).
 */
export const META_RUN_FNS: readonly AiProviderRunFnRegistration<any, any, MetaModelConfig>[] = [
  { serves: META_TEXT_GENERATION, runFn: Meta_TextGeneration_Stream },
  { serves: META_TOOL_USE, runFn: Meta_ToolCalling_Stream },
  { serves: META_JSON_MODE, runFn: Meta_StructuredGeneration_Stream },
  { serves: META_TEXT_REWRITER, runFn: Meta_TextRewriter_Stream },
  { serves: META_TEXT_SUMMARY, runFn: Meta_TextSummary_Stream },
  { serves: META_COUNT_TOKENS, runFn: Meta_CountTokens_Stream },
  { serves: META_MODEL_SEARCH, runFn: Meta_ModelSearch_Stream },
  { serves: META_MODEL_INFO, runFn: Meta_ModelInfo_Stream },
];

export const META_PREVIEW_TASKS: Record<
  string,
  AiProviderPreviewRunFn<any, any, MetaModelConfig>
> = {
  CountTokensTask: Meta_CountTokens_Preview,
};
