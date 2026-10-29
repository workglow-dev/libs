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
import { resolveAnthropicProfile } from "./Anthropic_ModelProfiles";

const CLAUDE = { supported: MODEL_EFFORTS, default: "none" } as const satisfies ModelEffortPolicy;

/**
 * Every generation from 3.7 up takes the coarse dial on one path or the other,
 * so only a profile whose thinking is `none` — the generations that predate
 * thinking, which 400 on any thinking field — is denied. An id the profile
 * table cannot read keeps the dial: it is far likelier a spelling not yet seen
 * than a model without thinking, and its profile routes it to the
 * `thinking.type = "enabled"` budget, which is the safe landing.
 */
export const anthropicEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveAnthropicProfile,
  (profile) => (profile.thinking === "none" ? EFFORT_POLICY_NONE : CLAUDE)
);
