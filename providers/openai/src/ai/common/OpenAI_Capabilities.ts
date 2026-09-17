/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { OPENAI_CAPABILITY_SETS } from "./OpenAI_CapabilitySets";

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
 * Shape used by the model-name regexes — `model_id` is required, the rest
 * is loosely-typed metadata only used to opportunistically widen the
 * inferred capability set.
 */
type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Heuristic capability inference for an OpenAI {@link ModelRecord}. Pattern-
 * matches the canonical OpenAI model id strings (and the `provider_config.
 * model_name` if present) to a closed set of {@link Capability}s. Falls back
 * to the model's stored `capabilities` array (or a baseline of search +
 * info) when no pattern matches.
 *
 * Main-thread method only — workers do not run capability inference.
 */
export function inferOpenAiCapabilities(model: CapabilityHints): readonly Capability[] {
  const id = String(
    model.model_id ??
      (model.provider_config as { model_name?: string } | undefined)?.model_name ??
      ""
  );

  // Embedding models — text-embedding-3-{small,large}, text-embedding-ada-002.
  if (/^text-embedding/i.test(id)) {
    return ["text.embedding", "model.count-tokens", "model.info", "model.search"];
  }

  // Image models — DALL-E and gpt-image families.
  if (/^dall-e/i.test(id)) {
    // DALL-E 2/3 do NOT support edit consistently — gpt-image-* does. Cover
    // generation only here; the gpt-image branch below adds editing.
    return ["image.generation", "model.info", "model.search"];
  }
  if (/^gpt-image/i.test(id)) {
    return ["image.generation", "image.editing", "model.info", "model.search"];
  }

  // Chat / reasoning models — gpt-3.5/4/4o/5/...; o-series reasoning models (o1, o3, o4, future).
  // GPT-4o, gpt-4-vision-*, gpt-4-turbo, and all o-series additionally accept image inputs.
  if (/^gpt-/i.test(id) || /^o\d/i.test(id)) {
    const caps: Capability[] = [
      "text.generation",
      "text.rewriter",
      "text.summary",
      "tool-use",
      "json-mode",
      "cache.checkpoint",
      "model.count-tokens",
      "model.info",
      "model.search",
    ];
    const supportsVision =
      /gpt-4o|gpt-4\.\d|gpt-5|gpt-6|gpt-4-vision|gpt-4-turbo/i.test(id) || /^o\d/i.test(id);
    if (supportsVision) {
      caps.push("vision-input");
    }
    return caps;
  }

  // Unknown model — fall back to whatever the record declared, or just
  // expose the meta-ops so the model can still be searched / inspected.
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  return ["model.search", "model.info"];
}
