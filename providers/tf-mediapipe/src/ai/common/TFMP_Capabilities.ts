/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { TFMP_CAPABILITY_SETS } from "./TFMP_CapabilitySets";
import { resolveTfmpRecordProfile, tfmpProfileCapabilities } from "./TFMP_ModelProfiles";

export const TFMP_RUN_FN_SPECS = TFMP_CAPABILITY_SETS.map((serves) => ({ serves }));

export function tfmpWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return TFMP_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a TensorFlow MediaPipe {@link ModelRecord}.
 *
 * Declared capabilities (set by model search) win. Otherwise the record's
 * profile answers: the pipeline its `provider_config.pipeline` names, else the
 * one its file name implies (see `TFMP_MODEL_FAMILIES`) — the same answer the
 * download run-fn opens the file with.
 */
export function inferTfmpCapabilities(model: CapabilityHints): readonly Capability[] {
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return tfmpProfileCapabilities(resolveTfmpRecordProfile(model).profile);
}
