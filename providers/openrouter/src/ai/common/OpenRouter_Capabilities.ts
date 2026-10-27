/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import { OPENROUTER_CAPABILITY_SETS } from "./OpenRouter_CapabilitySets";
import {
  OPENROUTER_BASELINE_CHAT,
  openRouterProfileCapabilities,
  resolveOpenRouterProfile,
} from "./OpenRouter_ModelProfiles";

export const OPENROUTER_RUN_FN_SPECS = OPENROUTER_CAPABILITY_SETS.map((serves) => ({ serves }));

export function openRouterWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return OPENROUTER_RUN_FN_SPECS;
}

interface OpenRouterModelMeta {
  readonly architecture?: {
    readonly input_modalities?: readonly string[];
    readonly modality?: string;
  };
  readonly supported_parameters?: readonly string[];
}

function hasModelMeta(meta: OpenRouterModelMeta | undefined): boolean {
  return (
    (meta?.architecture?.input_modalities?.length ?? 0) > 0 ||
    (meta?.supported_parameters?.length ?? 0) > 0
  );
}

/**
 * Derive the capability set from OpenRouter `/models` metadata: image input
 * modality → `vision-input`; `tools`/`tool_choice` → `tool-use`;
 * `response_format`/`structured_outputs` → `json-mode`. Always includes the
 * baseline chat set.
 */
export function deriveCapabilitiesFromMeta(
  meta: OpenRouterModelMeta | undefined
): readonly Capability[] {
  const caps = new Set<Capability>(OPENROUTER_BASELINE_CHAT);
  const modalities = meta?.architecture?.input_modalities ?? [];
  if (modalities.includes("image")) caps.add("vision-input");
  const params = meta?.supported_parameters ?? [];
  if (params.includes("tools") || params.includes("tool_choice")) caps.add("tool-use");
  if (params.includes("response_format") || params.includes("structured_outputs")) {
    caps.add("json-mode");
  }
  return [...caps];
}

/**
 * The capabilities a model id and its `/models` metadata describe. Metadata,
 * when there is any, is what OpenRouter says the routed model takes; without
 * it the model profile answers, so an id it knows is an embedding, image or
 * audio model is not advertised as chat.
 */
export function openRouterModelCapabilities(
  modelName: string | undefined,
  meta: OpenRouterModelMeta | undefined
): readonly Capability[] {
  if (hasModelMeta(meta)) return deriveCapabilitiesFromMeta(meta);
  return openRouterProfileCapabilities(resolveOpenRouterProfile(modelName).profile);
}

/**
 * Capability inference for an OpenRouter {@link ModelRecord}. Prefers the
 * record's stored metadata (populated at model-search time); then the record's
 * declared `capabilities`; then the model profile. The profile answers for an
 * id it does not recognize too: it takes one for a chat model, which is what
 * every entry `/models` lists serves.
 */
export function inferOpenRouterCapabilities(model: ModelRecord): readonly Capability[] {
  const meta = model.metadata as OpenRouterModelMeta | undefined;
  if (hasModelMeta(meta)) return deriveCapabilitiesFromMeta(meta);

  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;
  const name =
    (model.provider_config as { model_name?: string } | undefined)?.model_name ?? model.model_id;
  return openRouterModelCapabilities(name, undefined);
}
