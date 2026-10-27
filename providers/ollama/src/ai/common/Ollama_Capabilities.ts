/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { OLLAMA_CAPABILITY_SETS } from "./Ollama_CapabilitySets";
import { ollamaProfileCapabilities, resolveOllamaProfile } from "./Ollama_ModelProfiles";

/**
 * Closed list of capability-set specs the Ollama provider serves. Derived
 * from {@link OLLAMA_CAPABILITY_SETS} — do not edit here. Used by the
 * main-thread provider shells when registering worker-mode proxies.
 */
export const OLLAMA_RUN_FN_SPECS = OLLAMA_CAPABILITY_SETS.map((serves) => ({ serves }));

export function ollamaWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return OLLAMA_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for an Ollama {@link ModelRecord}, read off its profile
 * (see `OLLAMA_MODEL_FAMILIES`) by its id, or its `provider_config.model_name`
 * when there is no id. Ollama runs whatever the user pulled, so any named model
 * is recognized — as an embedding model, a vision model, or a text chat model —
 * and only a record with no name at all keeps what it declared.
 */
export function inferOllamaCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  const { profile, recognized } = resolveOllamaProfile(id);
  if (recognized) return ollamaProfileCapabilities(profile);

  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.search", "model.info"];
}
