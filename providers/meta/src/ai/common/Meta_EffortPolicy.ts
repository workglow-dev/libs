/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffortPolicy, ModelEffortPolicyFn } from "@workglow/ai/worker";
import { EFFORT_POLICY_NONE, makeProfileEffortPolicy } from "@workglow/ai/worker";
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

/** Takes `max`, but reasons at `high` when the field is omitted (Muse Spark 1.3). */
const REASONING_MAX_DEFAULT_HIGH = {
  supported: ["low", "medium", "high", "extra", "ultra"],
  default: "high",
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
    if (!profile.maxEffort) return REASONING;
    return profile.defaultsToMax ? REASONING_MAX : REASONING_MAX_DEFAULT_HIGH;
  }
);
