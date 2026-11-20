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

import { Meta_CountTokens_Preview, Meta_CountTokens_Stream } from "./Meta_CountTokens";
import { Meta_ModelInfo_Stream } from "./Meta_ModelInfo";
import { Meta_ModelSearch_Stream } from "./Meta_ModelSearch";
import { Meta_StructuredGeneration_Stream } from "./Meta_StructuredGeneration";
import { Meta_TextGeneration_Stream } from "./Meta_TextGeneration";
import { Meta_TextRewriter_Stream } from "./Meta_TextRewriter";
import { Meta_TextSummary_Stream } from "./Meta_TextSummary";
import { Meta_ToolCalling_Stream } from "./Meta_ToolCalling";

/**
 * Capability-set run-fn registrations for the Meta provider. Order is
 * significant only as a tiebreaker — the dispatcher prefers the smallest
 * `serves` set that is a superset of the task's `requires`, so the bare
 * `["text.generation"]` entry wins for a plain {@link TextGenerationTask} or
 * {@link AiChatTask} while the `["text.generation", "tool-use"]` entry wins
 * for {@link ToolCallingTask}.
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
