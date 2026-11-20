/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ModelSearchResultItem,
  ModelSearchTaskInput,
  ModelSearchTaskOutput,
} from "@workglow/ai";
import { filterLabeledModelsByQuery } from "@workglow/ai/provider-utils";
import type { Capability } from "@workglow/ai/worker";
import { stampEffortOptions } from "@workglow/ai/worker";
import { getClient } from "./Meta_Client";
import { META } from "./Meta_Constants";
import { metaEffortPolicy } from "./Meta_EffortPolicy";
import { resolveMetaProfile, metaProfileCapabilities } from "./Meta_ModelProfiles";

interface MetaModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

const META_FALLBACK: Array<{ label: string; value: string }> = [
  { label: "muse-spark-1.3", value: "muse-spark-1.3" },
  { label: "muse-spark-1.2", value: "muse-spark-1.2" },
  { label: "muse-spark-1.1", value: "muse-spark-1.1" },
  { label: "muse-spark-1.3-contributor", value: "muse-spark-1.3-contributor" },
  { label: "muse-spark-1.2-contributor", value: "muse-spark-1.2-contributor" },
  { label: "muse-wonder-1.0", value: "muse-wonder-1.0" },
  { label: "muse-ember-1.0", value: "muse-ember-1.0" },
];

/** What the profile table says a listed model serves; nothing for an id it does not recognize. */
function listedCapabilities(modelName: string): Capability[] {
  const { profile, recognized } = resolveMetaProfile(modelName);
  return recognized ? [...metaProfileCapabilities(profile)] : [];
}

async function listMetaModels(credentialKey: string): Promise<MetaModelListItem[]> {
  const client = await getClient({
    provider: META,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const models: MetaModelListItem[] = [];
  for await (const m of client.models.list()) {
    models.push({ label: m.id, value: m.id, description: m.owned_by });
  }
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

function mapModelList(models: MetaModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => ({
    id: m.value,
    label: m.label,
    description: m.description ?? "",
    record: stampEffortOptions(
      {
        model_id: m.value,
        provider: META,
        title: m.value,
        description: "",
        capabilities: listedCapabilities(m.value),
        provider_config: { model_name: m.value },
        metadata: {},
      },
      metaEffortPolicy({ provider: META, provider_config: { model_name: m.value } })
    ),
    raw: m,
  }));
}

/**
 * One-shot run-fn for `["model.search"]`. Emits a single `finish` event with
 * the search results. When no credential key is provided, falls back to a
 * curated static list of Meta's Muse chat models.
 */
export const Meta_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, _signal, emit) => {
  let models: MetaModelListItem[];
  if (!input.credential_key) {
    models = META_FALLBACK;
  } else {
    models = await listMetaModels(input.credential_key);
  }
  models = filterLabeledModelsByQuery(models, input.query);
  emit({ type: "finish", data: { results: mapModelList(models) } });
};
