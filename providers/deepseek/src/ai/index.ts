/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export {
  assertNotTruncatedByReasoning,
  DEEPSEEK_ALLOWED_HOSTS,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_REASONING_ALLOWANCE,
  reasoningParams,
  resolveMaxTokens,
} from "./common/DeepSeek_Client";
export * from "./common/DeepSeek_Constants";
export { deepseekEffortPolicy } from "./common/DeepSeek_EffortPolicy";
export * from "./common/DeepSeek_ModelSchema";
export * from "./common/DeepSeek_ModelSearch";
export * from "./common/DeepSeek_Pricing";
export {
  DeepSeekToolChoiceNotHonoredError,
  assertToolChoiceHonored,
  isForcingToolChoice,
} from "./common/DeepSeek_ToolCalling";
export * from "./registerDeepSeek";

import { DEEPSEEK_RUN_FN_SPECS } from "./common/DeepSeek_Capabilities";
import { _testOnly as clientTestOnly } from "./common/DeepSeek_Client";
import { DEEPSEEK_RUN_FNS } from "./common/DeepSeek_JobRunFns";
import { mapDeepSeekUsage } from "./common/DeepSeek_Usage";
import { DeepSeekQueuedProvider } from "./DeepSeekQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  DeepSeekQueuedProvider,
  DEEPSEEK_RUN_FN_SPECS,
  DEEPSEEK_RUN_FNS,
  mapDeepSeekUsage,
  setDeepSeekClientForTests: clientTestOnly.setDeepSeekClientForTests,
} as const;
