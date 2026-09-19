/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFnRegistration } from "@workglow/ai";
import {
  TYPESAFEAI_MODEL_INFO,
  TYPESAFEAI_MODEL_SEARCH,
  TYPESAFEAI_SYSTEM_ONE,
  TYPESAFEAI_TEXT_CLASSIFICATION,
  TYPESAFEAI_TEXT_RERANKING,
} from "./TypeSafeAi_CapabilitySets";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";

export { getClient, getModelName, loadTypeSafeSDK } from "./TypeSafeAi_Client";

import { TypeSafeAi_ModelInfo_Stream } from "./TypeSafeAi_ModelInfo";
import { TypeSafeAi_ModelSearch_Stream } from "./TypeSafeAi_ModelSearch";
import { TypeSafeAi_SystemOne_Stream } from "./TypeSafeAi_SystemOne";
import { TypeSafeAi_TextClassification_Stream } from "./TypeSafeAi_TextClassification";
import { TypeSafeAi_TextReranker_Stream } from "./TypeSafeAi_TextReranker";

/**
 * Capability-set run-fn registrations for the TypeSafe provider.
 *
 * Every entry is a single-capability set, so the dispatcher's most-specific-wins
 * tiebreak never has to pick between two of them: each task's `requires` matches
 * exactly one.
 */
export const TYPESAFEAI_RUN_FNS: readonly AiProviderRunFnRegistration<
  any,
  any,
  TypeSafeAiModelConfig
>[] = [
  { serves: TYPESAFEAI_SYSTEM_ONE, runFn: TypeSafeAi_SystemOne_Stream },
  { serves: TYPESAFEAI_TEXT_CLASSIFICATION, runFn: TypeSafeAi_TextClassification_Stream },
  { serves: TYPESAFEAI_TEXT_RERANKING, runFn: TypeSafeAi_TextReranker_Stream },
  { serves: TYPESAFEAI_MODEL_SEARCH, runFn: TypeSafeAi_ModelSearch_Stream },
  { serves: TYPESAFEAI_MODEL_INFO, runFn: TypeSafeAi_ModelInfo_Stream },
];
