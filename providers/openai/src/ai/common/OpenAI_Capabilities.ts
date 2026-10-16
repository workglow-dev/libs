/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { OPENAI_CAPABILITY_SETS } from "./OpenAI_CapabilitySets";
import { openAiProfileCapabilities, resolveOpenAiProfile } from "./OpenAI_ModelProfiles";

/**
 * Closed list of capability-set specs the OpenAI provider serves. Derived
 * from {@link OPENAI_CAPABILITY_SETS}. Used by the main-thread provider
 * shells when registering worker-mode proxies so the dispatcher can route
 * requests to the worker proxy.
 */
export const OPENAI_RUN_FN_SPECS = OPENAI_CAPABILITY_SETS.map((serves) => ({ serves }));

export function openAiWorkerRunFnSpecs(): readonly { readonly serves: readonly Capability[] }[] {
  return OPENAI_RUN_FN_SPECS;
}

/**
 * Shape read for the model id — `model_id` is required, the rest
 * is loosely-typed metadata only used to opportunistically widen the
 * inferred capability set.
 */
type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for an OpenAI {@link ModelRecord}. Reads the model's
 * profile (see `OPENAI_MODEL_PROFILES`) by its id, or its
 * `provider_config.model_name` when there is no id. Falls back
 * to the model's stored `capabilities` array (or a baseline of search +
 * info) when the id names no known family.
 *
 * Main-thread method only — workers do not run capability inference.
 */
export function inferOpenAiCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  const { profile } = resolveOpenAiProfile(id);
  if (profile !== undefined) return openAiProfileCapabilities(profile);

  // Unknown model — fall back to whatever the record declared, or just
  // expose the meta-ops so the model can still be searched / inspected.
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.search", "model.info"];
}
