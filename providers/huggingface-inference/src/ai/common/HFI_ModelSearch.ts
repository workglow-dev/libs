/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ModelSearchResultItem,
  ModelSearchTaskInput,
  ModelSearchTaskOutput,
} from "@workglow/ai";
import {
  filterLabeledModelsByQuery,
  mapHfModelResult,
  searchHfModels,
} from "@workglow/ai/provider-utils";
import { HF_INFERENCE } from "./HFI_Constants";
import { hfiProfileCapabilities, resolveHfiProfile } from "./HFI_ModelProfiles";

/**
 * The image tasks a model's profile row states, or `undefined` for a model with
 * no row. HF pipeline tags map to neither `image.generation` nor
 * `image.editing`, so a row is what says which of the two a model serves.
 */
function rowImageCapabilities(id: string): string[] | undefined {
  const { profile, source } = resolveHfiProfile(id);
  if (source !== "table") return undefined;
  return hfiProfileCapabilities(profile).filter((c) => c.startsWith("image."));
}

/** Offered without a key, in the Hub's own spelling of each id; every one has a profile row. */
const HFI_FALLBACK_MODEL_IDS: readonly string[] = [
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.1-Kontext-dev",
];

function buildFallbackResults(): ModelSearchResultItem[] {
  return HFI_FALLBACK_MODEL_IDS.map((id) => {
    const capabilities = rowImageCapabilities(id) ?? [];
    return {
      id,
      label: id,
      description: "",
      record: {
        model_id: id,
        provider: HF_INFERENCE,
        title: id.split("/").pop() ?? id,
        description: "",
        capabilities,
        provider_config: { model_name: id },
        metadata: {},
      },
      raw: { id, capabilities },
    };
  });
}

export const HFI_ModelSearch: AiProviderRunFn<ModelSearchTaskInput, ModelSearchTaskOutput> = async (
  input,
  _model,
  signal,
  emit
) => {
  const query = input.query?.trim() ?? "";
  if (!input.credential_key) {
    const fallback = buildFallbackResults();
    const labeled = fallback.map((r) => ({ label: r.label, value: r.id }));
    const filtered = filterLabeledModelsByQuery(labeled, query).map((m) =>
      fallback.find((r) => r.id === m.value)!
    );
    emit({ type: "finish", data: { results: filtered } });
    return;
  }

  const entries = await searchHfModels(query, undefined, undefined, signal, input.credential_key);
  const results = entries.map((entry) => {
    const mapped = mapHfModelResult(entry, HF_INFERENCE);
    const capabilities = rowImageCapabilities(entry.id);
    if (capabilities !== undefined) mapped.record.capabilities = capabilities;
    return mapped;
  });
  emit({ type: "finish", data: { results } });
};
