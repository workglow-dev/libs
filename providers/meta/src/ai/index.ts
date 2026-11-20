/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export {
  META_ALLOWED_HOSTS,
  META_API_KEY_ENV_VARS,
  META_DEFAULT_BASE_URL,
  getMetaReasoningEffort,
} from "./common/Meta_Client";
export * from "./common/Meta_Constants";
export { metaEffortPolicy } from "./common/Meta_EffortPolicy";
export * from "./common/Meta_ModelSchema";
export * from "./common/Meta_ModelSearch";
export * from "./common/Meta_Pricing";
export * from "./registerMeta";

import { inferMetaCapabilities, META_RUN_FN_SPECS } from "./common/Meta_Capabilities";
import { _testOnly as clientTestOnly } from "./common/Meta_Client";
import { META_RUN_FNS } from "./common/Meta_JobRunFns";
import {
  normalizeMetaModelId,
  resolveMetaProfile,
  META_MODEL_PROFILES,
  META_UNPRICED_PROFILE_IDS,
  metaProfileCapabilities,
} from "./common/Meta_ModelProfiles";
import { MetaQueuedProvider } from "./MetaQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  MetaQueuedProvider,
  META_RUN_FN_SPECS,
  META_RUN_FNS,
  META_MODEL_PROFILES,
  META_UNPRICED_PROFILE_IDS,
  normalizeMetaModelId,
  resolveMetaProfile,
  metaProfileCapabilities,
  inferMetaCapabilities,
  setMetaClientForTests: clientTestOnly.setMetaClientForTests,
  resetMetaStreamUsageSupportForTests: clientTestOnly.resetMetaStreamUsageSupportForTests,
} as const;
