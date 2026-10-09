/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./common/LlamaCpp_Constants";
export * from "./common/LlamaCpp_ModelSchema";
export { llamaCppEffortPolicy } from "./common/LlamaCpp_EffortPolicy";
// Mutable runtime state (e.g. llamaCppSessions) is intentionally NOT re-exported
// here. The `ai-provider` and `ai-runtime` entry points are bundled
// separately, so re-exporting from both creates two distinct module instances
// — and reads on one would not see writes from the other. Import runtime state
// from `@workglow/node-llama-cpp/ai-runtime` instead.
export * from "./registerLlamaCpp";

import { LLAMACPP_RUN_FN_SPECS } from "./common/LlamaCpp_Capabilities";
import { LLAMACPP_RUN_FNS } from "./common/LlamaCpp_JobRunFns";
import { LlamaCppQueuedProvider } from "./LlamaCppQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  LlamaCppQueuedProvider,
  LLAMACPP_RUN_FN_SPECS,
  LLAMACPP_RUN_FNS,
} as const;
