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
import { resolveXaiProfile } from "./Xai_ModelProfiles";

const REASONING = {
  supported: MODEL_EFFORTS,
  default: "medium",
} as const satisfies ModelEffortPolicy;

/**
 * Read off the profile's `reasoning`. xAI serves reasoning only on the Grok
 * text ids and rejects `reasoning_effort` elsewhere — image and
 * `non-reasoning` ids included — so an id the profile cannot place keeps the
 * plain path.
 */
export const xaiEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveXaiProfile,
  (profile) => (profile.kind === "chat" && profile.reasoning ? REASONING : EFFORT_POLICY_NONE)
);
