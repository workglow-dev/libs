/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_NONE,
  makeEffortPolicy,
  MODEL_EFFORTS,
  type ModelEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";

const REASONING = {
  supported: MODEL_EFFORTS,
  default: "high",
} as const satisfies ModelEffortPolicy;

/** V4 is the first family that reasons on every id; before it the mode is the id. */
function isReasoningDeepSeekFamily(id: string): boolean {
  const version = /^deepseek-v(\d+)/i.exec(id);
  return version !== null && Number(version[1]) >= 4;
}

/**
 * DeepSeek splits thinking by id rather than by parameter: `deepseek-reasoner`
 * is the thinking mode of the weights `deepseek-chat` serves without it, and
 * the V4 family reasons on every id. Matching `deepseek-v4` alone dropped the
 * dial on `deepseek-reasoner` — the vendor's own name for the thinking model —
 * while {@link resolveMaxTokens} still paid it the full default allowance.
 */
export const deepseekEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [
    {
      when: [
        isReasoningDeepSeekFamily,
        /^deepseek-flash/i,
        /^deepseek-reasoner/i,
        /^deepseek-r\d/i,
      ],
      policy: REASONING,
    },
  ],
  fallback: EFFORT_POLICY_NONE,
});
