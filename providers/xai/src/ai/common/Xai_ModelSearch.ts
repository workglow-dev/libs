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
import { getClient } from "./Xai_Client";
import { XAI } from "./Xai_Constants";
import { xaiEffortPolicy } from "./Xai_EffortPolicy";
import { resolveXaiProfile, xaiProfileCapabilities } from "./Xai_ModelProfiles";

interface XaiModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

const XAI_FALLBACK: Array<{ label: string; value: string }> = [
  { label: "grok-4.6", value: "grok-4.6" },
  { label: "grok-4.5", value: "grok-4.5" },
  { label: "grok-4", value: "grok-4" },
  { label: "grok-4-fast-reasoning", value: "grok-4-fast-reasoning" },
  { label: "grok-4-fast-non-reasoning", value: "grok-4-fast-non-reasoning" },
  { label: "grok-3", value: "grok-3" },
  { label: "grok-3-mini", value: "grok-3-mini" },
  { label: "grok-3-fast", value: "grok-3-fast" },
  { label: "grok-3-mini-fast", value: "grok-3-mini-fast" },
  { label: "grok-2-vision-1212", value: "grok-2-vision-1212" },
  { label: "grok-2-image-1212", value: "grok-2-image-1212" },
];

/** What the profile table says a listed model serves; nothing for an id it does not recognize. */
function listedCapabilities(modelName: string): Capability[] {
  const { profile, recognized } = resolveXaiProfile(modelName);
  return recognized ? [...xaiProfileCapabilities(profile)] : [];
}

async function listXaiModels(credentialKey: string): Promise<XaiModelListItem[]> {
  const client = await getClient({
    provider: XAI,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const models: XaiModelListItem[] = [];
  for await (const m of client.models.list()) {
    models.push({ label: m.id, value: m.id, description: m.owned_by });
  }
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

function mapModelList(models: XaiModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => ({
    id: m.value,
    label: m.label,
    description: m.description ?? "",
    record: stampEffortOptions(
      {
        model_id: m.value,
        provider: XAI,
        title: m.value,
        description: "",
        capabilities: listedCapabilities(m.value),
        provider_config: { model_name: m.value },
        metadata: {},
      },
      xaiEffortPolicy({ provider: XAI, provider_config: { model_name: m.value } })
    ),
    raw: m,
  }));
}

/**
 * One-shot run-fn for `["model.search"]`. Emits a single `finish` event with
 * the search results. When no credential key is provided, falls back to a
 * curated static list of well-known Grok models.
 */
export const Xai_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, _signal, emit) => {
  let models: XaiModelListItem[];
  if (!input.credential_key) {
    models = XAI_FALLBACK;
  } else {
    models = await listXaiModels(input.credential_key);
  }
  models = filterLabeledModelsByQuery(models, input.query);
  emit({ type: "finish", data: { results: mapModelList(models) } });
};
