/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  type ModelEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { resolveMetaProfile } from "./Meta_ModelProfiles";

/**
 * No `none`: every Muse model rejects `reasoning_effort: "none"` with a 400,
 * so the dial cannot turn reasoning off. `ultra` maps to `max`, which only some
 * models accept. The default is display-only and states what Meta does when
 * the field is omitted.
 */
const REASONING_MAX = {
  supported: ["low", "medium", "high", "extra", "ultra"],
  default: "ultra",
} as const satisfies ModelEffortPolicy;

const REASONING = {
  supported: ["low", "medium", "high", "extra"],
  default: "high",
} as const satisfies ModelEffortPolicy;

/**
 * Read off the profile. Muse Wonder and Ember default to `max`; every Muse
 * Spark version defaults to `high`. An id the profile cannot place keeps the
 * plain path.
 */
export const metaEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveMetaProfile,
  (profile) => {
    if (profile.kind !== "chat" || !profile.reasoning) return EFFORT_POLICY_NONE;
    return profile.maxEffort ? REASONING_MAX : REASONING;
  }
);
