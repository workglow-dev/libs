/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  MODEL_EFFORTS,
  type ModelEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { resolveOpenAiProfile } from "./OpenAI_ModelProfiles";

const REASONING = {
  supported: MODEL_EFFORTS,
  default: "medium",
} as const satisfies ModelEffortPolicy;

/**
 * A model that always reasons answers `reasoning.effort: "none"` with a 400
 * (`Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'`).
 */
const ALWAYS_REASONING = {
  supported: MODEL_EFFORTS.filter((effort) => effort !== "none"),
  default: "medium",
} as const satisfies ModelEffortPolicy;

/**
 * The pro models (gpt-5.2-pro, 5.4-pro, 5.5-pro) take `medium`, `high` and
 * `xhigh` only; any other level is left off the request, which then runs at
 * the class default.
 */
const PRO_REASONING = {
  supported: ["medium", "high", "extra"],
  default: "medium",
} as const satisfies ModelEffortPolicy;

/**
 * Read off the profile's `reasoning`. OpenAI rejects `reasoning` with a 400 on
 * the chat models that do not take it, so a model the profile table cannot
 * place keeps the plain no-reasoning path; a new reasoning family is one row
 * or family entry there rather than a live request that 400s.
 */
export const openaiEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveOpenAiProfile,
  (profile) => {
    if (profile.kind !== "chat") return EFFORT_POLICY_NONE;
    switch (profile.reasoning) {
      case "always":
        return ALWAYS_REASONING;
      case "pro":
        return PRO_REASONING;
      case "optional":
        return REASONING;
      case "none":
        return EFFORT_POLICY_NONE;
    }
  }
);
