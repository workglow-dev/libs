/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export { OPENROUTER_ALLOWED_HOSTS } from "./common/OpenRouter_Client";
export * from "./common/OpenRouter_Constants";
export * from "./common/OpenRouter_Capabilities";
export { openrouterEffortPolicy } from "./common/OpenRouter_EffortPolicy";
export * from "./common/OpenRouter_ModelSchema";
export * from "./common/OpenRouter_ModelSearch";
export * from "./registerOpenRouter";

import { OPENROUTER_RUN_FN_SPECS } from "./common/OpenRouter_Capabilities";
import { OPENROUTER_RUN_FNS } from "./common/OpenRouter_JobRunFns";
import {
  normalizeOpenRouterModelId,
  OPENROUTER_MODEL_FAMILIES,
  openRouterProfileCapabilities,
  resolveOpenRouterProfile,
} from "./common/OpenRouter_ModelProfiles";
import { mapOpenRouterModels } from "./common/OpenRouter_ModelSearch";
import { buildChatParams, buildOpenRouterExtras } from "./common/OpenRouter_RequestParams";
import { mapOpenRouterUsage } from "./common/OpenRouter_Usage";
import { OpenRouterQueuedProvider } from "./OpenRouterQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the
 * stable public API.
 */
export const _testOnly = {
  OpenRouterQueuedProvider,
  OPENROUTER_RUN_FN_SPECS,
  OPENROUTER_RUN_FNS,
  buildChatParams,
  buildOpenRouterExtras,
  mapOpenRouterModels,
  mapOpenRouterUsage,
  OPENROUTER_MODEL_FAMILIES,
  normalizeOpenRouterModelId,
  resolveOpenRouterProfile,
  openRouterProfileCapabilities,
} as const;
