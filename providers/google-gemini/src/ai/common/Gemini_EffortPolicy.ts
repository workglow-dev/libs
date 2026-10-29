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
import { resolveGeminiProfile } from "./Gemini_ModelProfiles";

const TEXT = { supported: MODEL_EFFORTS, default: "none" } as const satisfies ModelEffortPolicy;

/**
 * Read off the profile's `thinks`. Gemini rejects `thinkingConfig` on the models
 * that do not think — embedding and image ids, and chat models before 2.5 — so
 * only a thinking chat model takes the dial.
 */
export const geminiEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveGeminiProfile,
  (profile) => (profile.kind === "chat" && profile.thinks ? TEXT : EFFORT_POLICY_NONE)
);
