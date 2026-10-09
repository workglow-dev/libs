/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_ALL,
  EFFORT_POLICY_NONE,
  makeEffortPolicy,
  resolveEnabledEffort,
  type ModelEffort,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import type { HfInferenceModelConfig } from "./HFI_ModelSchema";

/** Ids on the router that are not chat models, so take no reasoning dial. */
const NON_TEXT = [
  /embed/i,
  /(?:^|\/)(?:bge|gte|e5)-/i,
  /rerank/i,
  /stable-diffusion|flux|sdxl/i,
  /whisper|tts/i,
];

/**
 * The router forwards to many backends and drops nothing on its own, so an id
 * no rule recognizes keeps the dial; the field is sent only when a caller set
 * an effort.
 */
export const hfiEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [{ when: NON_TEXT, policy: EFFORT_POLICY_NONE }],
  fallback: EFFORT_POLICY_ALL,
});

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
