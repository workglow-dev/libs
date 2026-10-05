/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { ANTHROPIC_CAPABILITY_SETS } from "./Anthropic_CapabilitySets";
import { anthropicProfileCapabilities, resolveAnthropicProfile } from "./Anthropic_ModelProfiles";

/**
 * Closed list of capability-set specs the Anthropic provider serves. Derived
 * from {@link ANTHROPIC_CAPABILITY_SETS}. Used by the main-thread provider
 * shells when registering worker-mode proxies so the dispatcher can route
 * requests to the worker proxy.
 */
export const ANTHROPIC_RUN_FN_SPECS = ANTHROPIC_CAPABILITY_SETS.map((serves) => ({ serves }));

export function anthropicWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return ANTHROPIC_RUN_FN_SPECS;
}

/**
 * Shape read for the model id — `model_id` is required, the rest
 * is loosely-typed metadata only used to opportunistically widen the
 * inferred capability set.
 */
type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for an Anthropic {@link ModelRecord}. Reads the model's
 * profile (see `ANTHROPIC_MODEL_PROFILES`) by its id, or its
 * `provider_config.model_name` when there is no id. Falls back
 * to the model's stored `capabilities` array (or a baseline of search +
 * info) when no pattern matches.
 *
 * Main-thread method only — workers do not run capability inference.
 */
export function inferAnthropicCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  const resolved = resolveAnthropicProfile(id);
  if (resolved.recognized) return anthropicProfileCapabilities(resolved.profile);

  // Unknown Claude id with declared capabilities → return as-is.
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  // Unknown id with no declared caps → baseline meta-ops.
  return ["model.search", "model.info"];
}
