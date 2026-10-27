/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { LLAMACPP_CAPABILITY_SETS } from "./LlamaCpp_CapabilitySets";
import { llamaCppProfileCapabilities, resolveLlamaCppModelProfile } from "./LlamaCpp_ModelProfiles";

export const LLAMACPP_RUN_FN_SPECS = LLAMACPP_CAPABILITY_SETS.map((serves) => ({ serves }));

export function llamaCppWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return LLAMACPP_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a node-llama-cpp {@link ModelRecord}. Declared
 * capabilities win: a GGUF is a file the user chose, and its record is the
 * best statement of what it is. Otherwise the model's profile (see
 * `LLAMACPP_MODEL_FAMILIES`) is read from the names its weights go by.
 */
export function inferLlamaCppCapabilities(model: CapabilityHints): readonly Capability[] {
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;

  const { profile, recognized } = resolveLlamaCppModelProfile(model);
  if (recognized) return llamaCppProfileCapabilities(profile);
  return ["model.search", "model.info"];
}
