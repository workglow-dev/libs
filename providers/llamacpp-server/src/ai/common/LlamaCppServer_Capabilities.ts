/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { LLAMACPP_SERVER_CAPABILITY_SETS } from "./LlamaCppServer_CapabilitySets";
import {
  llamaCppServerProfileCapabilities,
  resolveLlamaCppServerProfile,
} from "./LlamaCppServer_ModelProfiles";

export const LLAMACPP_SERVER_RUN_FN_SPECS = LLAMACPP_SERVER_CAPABILITY_SETS.map((serves) => ({
  serves,
}));

export function llamaCppServerWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return LLAMACPP_SERVER_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference, read off the model's profile (see
 * `LLAMACPP_SERVER_MODEL_FAMILIES`) by its `provider_config.model_path`, else
 * its `model_name`, else its id. `provider_config.native_dimensions` is a
 * statement about the model rather than a guess from its name, so it decides
 * first: only an embedding model has a vector width. A record with no name at
 * all keeps what it declared.
 */
export function inferLlamaCppServerCapabilities(model: CapabilityHints): readonly Capability[] {
  const pc = model.provider_config as
    | { model_path?: string; model_name?: string; native_dimensions?: number }
    | undefined;

  if (typeof pc?.native_dimensions === "number") {
    return llamaCppServerProfileCapabilities({ kind: "embedding" });
  }

  const id = String(pc?.model_path ?? pc?.model_name ?? model.model_id ?? "");
  const { profile, recognized } = resolveLlamaCppServerProfile(id);
  if (recognized) return llamaCppServerProfileCapabilities(profile);

  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.info", "model.search"];
}
