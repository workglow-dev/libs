/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { TYPESAFEAI_CAPABILITY_SETS } from "./TypeSafeAi_CapabilitySets";

/**
 * Closed list of capability-set specs the TypeSafe provider serves. Derived
 * from {@link TYPESAFEAI_CAPABILITY_SETS}. Used by the main-thread provider
 * shells when registering worker-mode proxies so the dispatcher can route
 * requests to the worker proxy.
 */
export const TYPESAFEAI_RUN_FN_SPECS = TYPESAFEAI_CAPABILITY_SETS.map((serves) => ({ serves }));

export function typeSafeAiWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return TYPESAFEAI_RUN_FN_SPECS;
}

/**
 * Shape used by the model-name regexes — `model_id` is required, the rest is
 * loosely-typed metadata only used to opportunistically widen the inferred
 * capability set.
 */
type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Heuristic capability inference for a TypeSafe {@link ModelRecord}.
 *
 * Jev is a System One model: it returns typed answers to named questions and
 * never writes text. So the inferred set never includes `text.generation`,
 * `tool-use`, `json-mode`, any embedding or any image capability — a record
 * claiming one of those would clear the task's capability gate and then fail
 * inside the provider, with the useful "model is missing capabilities" message
 * replaced by whatever the API said.
 *
 * What it does infer is the native `judgment.systemone` surface plus the two
 * existing tasks a Choice and a Noul answer serve honestly — classification
 * (which is a Choice over caller-supplied labels) and reranking (a Noul per
 * candidate) — and the catalog meta-ops.
 *
 * Main-thread method only — workers do not run capability inference.
 */
export function inferTypeSafeAiCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  // Jev and its aliases — `jev-latest`, `jev-preview`, `jev-1.13.0`, and future
  // `jev-*` releases served by the same endpoint.
  if (/^jev/i.test(id)) {
    return [
      "judgment.systemone",
      "text.classification",
      "text.reranking",
      "model.info",
      "model.search",
    ];
  }

  // Unknown model — fall back to whatever the record declared, or just expose
  // the meta-ops so the model can still be searched / inspected.
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.search", "model.info"];
}
