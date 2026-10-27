/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_ALL,
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  resolveEnabledEffort,
  type ModelEffort,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { resolveHfiProfile } from "./HFI_ModelProfiles";
import type { HfInferenceModelConfig } from "./HFI_ModelSchema";

/**
 * Read off the profile's kind: only a chat model takes the reasoning dial. The
 * router forwards to many backends and drops nothing on its own, so an id the
 * profile cannot place — taken for a chat model — keeps the dial; the field is
 * sent only when a caller set an effort.
 */
export const hfiEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveHfiProfile,
  (profile) => (profile.kind === "chat" ? EFFORT_POLICY_ALL : EFFORT_POLICY_NONE)
);

const EFFORT_TO_REASONING_EFFORT: Record<Exclude<ModelEffort, "none">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "high",
  ultra: "high",
};

/** The chat-completions `reasoning_effort` field for a model's effort, or nothing. */
export function hfiReasoningParams(model: HfInferenceModelConfig | undefined): {
  reasoning_effort?: string;
} {
  const effort = resolveEnabledEffort(model, hfiEffortPolicy(model));
  if (effort === undefined || effort === "none") return {};
  return { reasoning_effort: EFFORT_TO_REASONING_EFFORT[effort] };
}
