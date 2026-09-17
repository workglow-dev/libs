/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
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
  default: "medium",
} as const satisfies ModelEffortPolicy;

/**
 * OpenAI rejects `reasoning` with a 400 on the chat models that do not take it,
 * and those — `gpt-4o`, `gpt-4.1`, `chatgpt-*` — are most of what does not match
 * a rule here, so an unrecognized id keeps the plain no-reasoning path. A new
 * reasoning family is one entry below rather than a live request that 400s.
 */
export const openaiEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [
    { when: [/^text-embedding/i, /^gpt-image/i, /^dall-e/i], policy: EFFORT_POLICY_NONE },
    { when: [/^gpt-5/i, /^gpt-6/i, /^o[134]/i], policy: REASONING },
  ],
  fallback: EFFORT_POLICY_NONE,
});
