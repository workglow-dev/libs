/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { CACTUS_CAPABILITY_SETS } from "./Cactus_CapabilitySets";

export const CACTUS_RUN_FN_SPECS = CACTUS_CAPABILITY_SETS.map((serves) => ({ serves }));

export function cactusWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return CACTUS_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * needle-rs v1, v2 and v3 share one capability set; inference does not vary by
 * generation. The heads that do differ (v3 drops the retrieval head, v2 has
 * one) are not surfaced as task capabilities.
 */
export function inferCactusCapabilities(_model: CapabilityHints): readonly Capability[] {
  return ["tool-use", "model.download", "model.download-remove", "model.search", "model.info"];
}
