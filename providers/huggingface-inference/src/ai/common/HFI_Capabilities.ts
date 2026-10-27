/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { HFI_CAPABILITY_SETS } from "./HFI_CapabilitySets";
import { hfiProfileCapabilities, resolveHfiProfile } from "./HFI_ModelProfiles";

export const HFI_RUN_FN_SPECS = HFI_CAPABILITY_SETS.map((serves) => ({ serves }));

export function hfInferenceWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return HFI_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a HuggingFace Inference {@link ModelRecord}.
 *
 * HF Inference catalog items are HF Hub repo IDs (e.g. `mistralai/Mistral-7B-Instruct`,
 * `black-forest-labs/FLUX.1-dev`). Like HFT, declared capabilities (set by
 * model-search) win. Otherwise the model profile answers for an id it
 * recognizes, and an id it does not gets only the meta-ops.
 */
export function inferHfInferenceCapabilities(model: CapabilityHints): readonly Capability[] {
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;

  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );
  const { profile, recognized } = resolveHfiProfile(id);
  if (recognized) return hfiProfileCapabilities(profile);
  return ["model.search", "model.info"];
}
