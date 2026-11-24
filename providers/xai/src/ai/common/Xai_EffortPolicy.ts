/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffort, ModelEffortPolicy, ModelEffortPolicyFn } from "@workglow/ai/worker";
import { EFFORT_POLICY_NONE, makeProfileEffortPolicy } from "@workglow/ai/worker";
import type { XaiChatProfile, XaiReasoningEffort } from "./Xai_ModelProfiles";
import { resolveXaiProfile } from "./Xai_ModelProfiles";

/** The coarse dial level a native xAI effort is shown as. */
const DIAL_FOR_XAI: Record<XaiReasoningEffort, ModelEffort> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra",
};

/**
 * The dial levels a reasoning profile offers: each native level it accepts, and
 * `extra` and `ultra` on every one, which send its top level (`xhigh` where it
 * is accepted, otherwise `high`). `none` is offered only where xAI accepts it.
 */
function reasoningPolicy(profile: XaiChatProfile): ModelEffortPolicy {
  const supported = new Set<ModelEffort>();
  for (const effort of profile.efforts) {
    if (effort !== "xhigh") supported.add(DIAL_FOR_XAI[effort]);
  }
  supported.add("extra");
  supported.add("ultra");
  return {
    supported: [...supported],
    default: DIAL_FOR_XAI[profile.defaultEffort],
  };
}

/**
 * Read off the profile. xAI serves reasoning only on the Grok text ids and
 * rejects `reasoning_effort` elsewhere — image and `non-reasoning` ids
 * included — so an id the profile cannot place keeps the plain path.
 */
export const xaiEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveXaiProfile,
  (profile) =>
    profile.kind === "chat" && profile.reasoning ? reasoningPolicy(profile) : EFFORT_POLICY_NONE
);
