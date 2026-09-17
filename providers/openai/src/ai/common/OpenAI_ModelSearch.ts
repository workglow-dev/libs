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
import { filterLabeledModelsByQuery } from "@workglow/ai/provider-utils";
import { stampEffortOptions } from "@workglow/ai/worker";
import { getClient } from "./OpenAI_Client";
import { OPENAI } from "./OpenAI_Constants";
import { openaiEffortPolicy } from "./OpenAI_EffortPolicy";

interface OpenAiModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

const OPENAI_FALLBACK: Array<{ label: string; value: string }> = [
  { label: "gpt-6-astra", value: "gpt-6-astra" },
  { label: "gpt-image-2.5-sunburst", value: "gpt-image-2.5-sunburst" },
  { label: "gpt-image-2.5-flare", value: "gpt-image-2.5-flare" },
  { label: "gpt-image-2", value: "gpt-image-2" },
  { label: "dall-e-3", value: "dall-e-3" },
  { label: "gpt-5.6", value: "gpt-5.6" },
  { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
  { label: "gpt-5.6-terra", value: "gpt-5.6-terra" },
  { label: "gpt-5.6-luna", value: "gpt-5.6-luna" },
  { label: "gpt-5.5", value: "gpt-5.5" },
  { label: "gpt-5.4-mini", value: "gpt-5.4-mini" },
  { label: "gpt-5.4-nano", value: "gpt-5.4-nano" },
  { label: "gpt-5", value: "gpt-5" },
  { label: "gpt-5-mini", value: "gpt-5-mini" },
  { label: "gpt-4o-mini", value: "gpt-4o-mini" },
  { label: "gpt-4-turbo", value: "gpt-4-turbo" },
  { label: "o3", value: "o3" },
  { label: "o3-mini", value: "o3-mini" },
  { label: "o1", value: "o1" },
  { label: "o1-mini", value: "o1-mini" },
];

const OPENAI_IMAGE_MODELS: Array<{ value: string; capabilities: string[] }> = [
  { value: "gpt-image-2.5-sunburst", capabilities: ["image.generation", "image.editing"] },
  { value: "gpt-image-2.5-flare", capabilities: ["image.generation", "image.editing"] },
  { value: "gpt-image-2", capabilities: ["image.generation", "image.editing"] },
  { value: "dall-e-3", capabilities: ["image.generation"] },
];

async function listOpenAiModels(credentialKey: string): Promise<OpenAiModelListItem[]> {
  const client = await getClient({
    provider: OPENAI,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const models: OpenAiModelListItem[] = [];
  for await (const m of client.models.list()) {
    models.push({ label: m.id, value: m.id, description: m.owned_by });
  }
  models.sort((a, b) => {
    const aGpt = a.value.startsWith("gpt") || a.value.startsWith("o1") ? 0 : 1;
    const bGpt = b.value.startsWith("gpt") || b.value.startsWith("o1") ? 0 : 1;
    if (aGpt !== bGpt) return aGpt - bGpt;
    return a.value.localeCompare(b.value);
  });
  return models;
}

function mapModelList(models: OpenAiModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => {
    const imageEntry = OPENAI_IMAGE_MODELS.find((i) => i.value === m.value);
    return {
      id: m.value,
      label: m.label,
      description: m.description ?? "",
      record: stampEffortOptions(
        {
          model_id: m.value,
          provider: OPENAI,
          title: m.value,
          description: "",
          capabilities: imageEntry?.capabilities ?? [],
          provider_config: { model_name: m.value },
          metadata: {},
        },
        openaiEffortPolicy({ provider: OPENAI, provider_config: { model_name: m.value } })
      ),
      raw: m,
    };
  });
}

/**
 * One-shot run-fn for `["model.search"]`. Emits a
 * single `finish` event with the search results. When no credential key is
 * provided, falls back to a curated static list of well-known OpenAI models.
 */
export const OpenAI_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, _signal, emit) => {
  let models: OpenAiModelListItem[];
  if (!input.credential_key) {
    models = OPENAI_FALLBACK;
  } else {
    models = await listOpenAiModels(input.credential_key);
  }
  models = filterLabeledModelsByQuery(models, input.query);
  emit({ type: "finish", data: { results: mapModelList(models) } });
};
