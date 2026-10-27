/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { HFT_CAPABILITY_SETS } from "./HFT_CapabilitySets";
import { hftProfileCapabilities, resolveHftRecordProfile } from "./HFT_ModelProfiles";

export const HFT_RUN_FN_SPECS = HFT_CAPABILITY_SETS.map((serves) => ({ serves }));

export function hftWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return HFT_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a HuggingFace Transformers {@link ModelRecord}.
 *
 * Declared capabilities win unconditionally (model search populates them from
 * HF Hub tags). Otherwise the record's profile answers — its
 * `provider_config.pipeline_task` hint, else its repo name (see
 * `HFT_MODEL_FAMILIES`).
 */
export function inferHftCapabilities(model: CapabilityHints): readonly Capability[] {
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return hftProfileCapabilities(resolveHftRecordProfile(model).profile);
}
