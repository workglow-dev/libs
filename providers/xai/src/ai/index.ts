/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export {
  XAI_ALLOWED_HOSTS,
  XAI_DEFAULT_BASE_URL,
  getXaiReasoningEffort,
} from "./common/Xai_Client";
export * from "./common/Xai_Constants";
export { xaiEffortPolicy } from "./common/Xai_EffortPolicy";
export * from "./common/Xai_ModelSchema";
export * from "./common/Xai_ModelSearch";
export * from "./common/Xai_Pricing";
export * from "./registerXai";

import { inferXaiCapabilities, XAI_RUN_FN_SPECS } from "./common/Xai_Capabilities";
import { _testOnly as clientTestOnly } from "./common/Xai_Client";
import { XAI_RUN_FNS } from "./common/Xai_JobRunFns";
import {
  normalizeXaiModelId,
  resolveXaiProfile,
  XAI_MODEL_PROFILES,
  XAI_UNPRICED_PROFILE_IDS,
  xaiProfileCapabilities,
} from "./common/Xai_ModelProfiles";
import { XaiQueuedProvider } from "./XaiQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  XaiQueuedProvider,
  XAI_RUN_FN_SPECS,
  XAI_RUN_FNS,
  XAI_MODEL_PROFILES,
  XAI_UNPRICED_PROFILE_IDS,
  normalizeXaiModelId,
  resolveXaiProfile,
  xaiProfileCapabilities,
  inferXaiCapabilities,
  setXaiClientForTests: clientTestOnly.setXaiClientForTests,
} as const;
