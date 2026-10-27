/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  MODEL_EFFORTS,
  type ModelEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { resolveDeepSeekProfile } from "./DeepSeek_ModelProfiles";

const REASONING = {
  supported: MODEL_EFFORTS,
  default: "high",
} as const satisfies ModelEffortPolicy;

/**
 * Read off the profile's `reasoning`. DeepSeek splits thinking by id rather
 * than by parameter: `deepseek-reasoner` is the thinking mode of the weights
 * `deepseek-chat` serves without it, and the V4 family reasons on every id.
 * {@link resolveMaxTokens} reads the same policy, so the reasoning allowance is
 * paid exactly where the dial is offered.
 */
export const deepseekEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveDeepSeekProfile,
  (profile) => (profile.reasoning ? REASONING : EFFORT_POLICY_NONE)
);
