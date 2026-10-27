/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { DEEPSEEK_CAPABILITY_SETS } from "./DeepSeek_CapabilitySets";
import { deepSeekProfileCapabilities, resolveDeepSeekProfile } from "./DeepSeek_ModelProfiles";

/**
 * Closed list of capability-set specs the DeepSeek provider serves. Derived
 * from {@link DEEPSEEK_CAPABILITY_SETS}. Used by the main-thread provider
 * shells when registering worker-mode proxies so the dispatcher can route
 * requests to the worker proxy.
 */
export const DEEPSEEK_RUN_FN_SPECS = DEEPSEEK_CAPABILITY_SETS.map((serves) => ({ serves }));

export function deepSeekWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return DEEPSEEK_RUN_FN_SPECS;
}

/**
 * Shape read for the model id — `model_id` is required, the rest is
 * loosely-typed metadata only used to opportunistically widen the inferred
 * capability set.
 */
type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a DeepSeek {@link ModelRecord}. Reads the model's
 * profile (see `DEEPSEEK_MODEL_PROFILES`) by its id, or its
 * `provider_config.model_name` when there is no id. Falls back to the model's
 * stored `capabilities` array (or a baseline of search + info) when the id
 * names no known family.
 *
 * The DeepSeek chat models are text-only — no vision input and no image
 * generation — so the inferred set never includes those.
 *
 * Main-thread method only — workers do not run capability inference.
 */
export function inferDeepSeekCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  const { profile, recognized } = resolveDeepSeekProfile(id);
  if (recognized) return deepSeekProfileCapabilities(profile);

  // Unknown model — fall back to whatever the record declared, or just expose
  // the meta-ops so the model can still be searched / inspected.
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.search", "model.info"];
}
