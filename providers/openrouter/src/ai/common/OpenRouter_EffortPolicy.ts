/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_ALL,
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { resolveOpenRouterProfile } from "./OpenRouter_ModelProfiles";

/**
 * Read off the profile's kind. OpenRouter drops a parameter the routed model
 * does not accept rather than rejecting the request, so a chat model — and an
 * id the profile cannot place, which it takes for one — keeps the dial. What it
 * cannot do is make a non-text model reason: returning every level for every
 * id, embeddings and image models included, left the gate at the call site a
 * literal no-op.
 */
export const openrouterEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveOpenRouterProfile,
  (profile) => (profile.kind === "chat" ? EFFORT_POLICY_ALL : EFFORT_POLICY_NONE)
);
