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
import { getClient } from "./Anthropic_Client";
import { ANTHROPIC } from "./Anthropic_Constants";
import { anthropicEffortPolicy } from "./Anthropic_EffortPolicy";

interface AnthropicModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

/**
 * Offered when no credential is available to list models live. Newest first,
 * and limited to ids that are generally available — a model restricted to an
 * invite-only program would 404 for everyone else.
 */
export const ANTHROPIC_FALLBACK: ReadonlyArray<{ readonly label: string; readonly value: string }> =
  [
    { label: "claude-fable-5-1", value: "claude-fable-5-1" },
    { label: "claude-fable-5", value: "claude-fable-5" },
    { label: "claude-opus-5-5", value: "claude-opus-5-5" },
    { label: "claude-sonnet-5-5", value: "claude-sonnet-5-5" },
    { label: "claude-opus-5", value: "claude-opus-5" },
    { label: "claude-sonnet-5", value: "claude-sonnet-5" },
    { label: "claude-opus-4-8", value: "claude-opus-4-8" },
    { label: "claude-opus-4-7", value: "claude-opus-4-7" },
    { label: "claude-haiku-4-5", value: "claude-haiku-4-5" },
    { label: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
    { label: "claude-opus-4-6", value: "claude-opus-4-6" },
    { label: "claude-sonnet-4-5-20250929", value: "claude-sonnet-4-5-20250929" },
  ];

async function listAnthropicModels(credentialKey: string): Promise<AnthropicModelListItem[]> {
  const client = await getClient({
    provider: ANTHROPIC,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const models: AnthropicModelListItem[] = [];
  for await (const m of client.beta.models.list()) {
    models.push({ label: m.display_name, value: m.id, description: m.id });
  }
  return models;
}

function mapModelList(models: AnthropicModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => ({
    id: m.value,
    label: m.label,
    description: m.description ?? "",
    record: stampEffortOptions(
      {
        model_id: m.value,
        provider: ANTHROPIC,
        title: m.value,
        description: "",
        capabilities: [],
        provider_config: { model_name: m.value },
        metadata: {},
      },
      anthropicEffortPolicy({
        provider: ANTHROPIC,
        provider_config: { model_name: m.value },
      })
    ),
    raw: m,
  }));
}

export const Anthropic_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, _signal, emit) => {
  const available: ReadonlyArray<AnthropicModelListItem> = input.credential_key
    ? await listAnthropicModels(input.credential_key)
    : ANTHROPIC_FALLBACK;
  const models = filterLabeledModelsByQuery(available, input.query);
  emit({ type: "finish", data: { results: mapModelList(models) } });
};
