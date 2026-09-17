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
import { stampEffortOptions } from "@workglow/ai/worker";
import { getClient } from "./DeepSeek_Client";
import { DEEPSEEK } from "./DeepSeek_Constants";
import { deepseekEffortPolicy } from "./DeepSeek_EffortPolicy";

interface DeepSeekModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

const DEEPSEEK_FALLBACK: Array<{ label: string; value: string }> = [
  { label: "deepseek-flash", value: "deepseek-flash" },
  { label: "deepseek-v4-pro-0813", value: "deepseek-v4-pro-0813" },
  { label: "deepseek-v4-flash", value: "deepseek-v4-flash" },
  { label: "deepseek-v4.1-flash", value: "deepseek-v4.1-flash" },
  { label: "deepseek-v4-pro", value: "deepseek-v4-pro" },
];

async function listDeepSeekModels(credentialKey: string): Promise<DeepSeekModelListItem[]> {
  const client = await getClient({
    provider: DEEPSEEK,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const models: DeepSeekModelListItem[] = [];
  for await (const m of client.models.list()) {
    models.push({ label: m.id, value: m.id, description: m.owned_by });
  }
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

function mapModelList(models: DeepSeekModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => ({
    id: m.value,
    label: m.label,
    description: m.description ?? "",
    record: stampEffortOptions(
      {
        model_id: m.value,
        provider: DEEPSEEK,
        title: m.value,
        description: "",
        capabilities: [],
        provider_config: { model_name: m.value },
        metadata: {},
      },
      deepseekEffortPolicy({
        provider: DEEPSEEK,
        provider_config: { model_name: m.value },
      })
    ),
    raw: m,
  }));
}

/**
 * One-shot run-fn for `["model.search"]`. Emits a single `finish` event with
 * the search results. When no credential key is provided, falls back to a
 * curated static list of well-known DeepSeek models.
 */
export const DeepSeek_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, _signal, emit) => {
  let models: DeepSeekModelListItem[];
  if (!input.credential_key) {
    models = DEEPSEEK_FALLBACK;
  } else {
    models = await listDeepSeekModels(input.credential_key);
  }
  models = filterLabeledModelsByQuery(models, input.query);
  emit({ type: "finish", data: { results: mapModelList(models) } });
};
