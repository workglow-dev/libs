/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export {
  TYPESAFEAI_ALLOWED_HOSTS,
  TYPESAFEAI_DEFAULT_BASE_URL,
  TYPESAFEAI_DEFAULT_MODEL_NAME,
  TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY,
  resolveRerankConcurrency,
} from "./common/TypeSafeAi_Client";
export type {
  TypeSafeAnswer,
  TypeSafeChoiceAnswer,
  TypeSafeClientLike,
  TypeSafeEntry,
  TypeSafeModelCard,
  TypeSafeNoulAnswer,
  TypeSafeQuestion,
  TypeSafeScoreAnswer,
  TypeSafeSystemOneResult,
  TypeSafeUsagePayload,
} from "./common/TypeSafeAi_Client";
export * from "./common/TypeSafeAi_Constants";
export * from "./common/TypeSafeAi_Capabilities";
export * from "./common/TypeSafeAi_ModelSchema";
export * from "./common/TypeSafeAi_ModelSearch";
export * from "./common/TypeSafeAi_Pricing";
export * from "./registerTypeSafeAi";

import { TYPESAFEAI_RUN_FN_SPECS } from "./common/TypeSafeAi_Capabilities";
import { _testOnly as clientTestOnly } from "./common/TypeSafeAi_Client";
import { TYPESAFEAI_RUN_FNS } from "./common/TypeSafeAi_JobRunFns";
import { addTypeSafeAiUsage, mapTypeSafeAiUsage } from "./common/TypeSafeAi_Usage";
import { TypeSafeAiQueuedProvider } from "./TypeSafeAiQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  TypeSafeAiQueuedProvider,
  TYPESAFEAI_RUN_FN_SPECS,
  TYPESAFEAI_RUN_FNS,
  addTypeSafeAiUsage,
  mapTypeSafeAiUsage,
  setTypeSafeAiClientForTests: clientTestOnly.setTypeSafeAiClientForTests,
} as const;
