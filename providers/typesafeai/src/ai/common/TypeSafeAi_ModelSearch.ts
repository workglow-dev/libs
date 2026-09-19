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
import { getClient } from "./TypeSafeAi_Client";
import { TYPESAFEAI } from "./TypeSafeAi_Constants";

interface TypeSafeModelListItem {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

/**
 * What `GET /v1/models` returns for every account: the two aliases. A versioned
 * id is accepted by the `model` field whether or not it is listed, so this is a
 * starting set rather than the whole namespace.
 *
 * The descriptions are the vendor's own, copied from a live listing rather than
 * written here, so the keyless and keyed paths do not describe the same model
 * two different ways in the same catalog.
 */
const TYPESAFEAI_FALLBACK: Array<{ label: string; value: string; description: string }> = [
  {
    label: "jev-latest",
    value: "jev-latest",
    description: "The latest iteration of TypeSafe's System One Model: Jev",
  },
  {
    label: "jev-preview",
    value: "jev-preview",
    description: "A preview version of `jev-latest`: should be better in most ways",
  },
];

async function listTypeSafeModels(
  credentialKey: string,
  signal: AbortSignal
): Promise<TypeSafeModelListItem[]> {
  const client = await getClient({
    provider: TYPESAFEAI,
    provider_config: { model_name: "", credential_key: credentialKey },
  });
  const cards = await client.models.list({ signal });
  const models = cards.map((card) => ({
    label: card.name,
    value: card.name,
    description: card.description ?? "",
  }));
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

/**
 * Build the record a search result seeds a catalog entry with.
 *
 * `capabilities` is left empty so the provider's own `inferCapabilities` fills
 * it, the same way it does for a record typed in by hand — stamping a list here
 * would make the two paths disagree about the same model.
 */
export function mapTypeSafeAiModels(models: TypeSafeModelListItem[]): ModelSearchResultItem[] {
  return models.map((m) => ({
    id: m.value,
    label: m.label,
    description: m.description ?? "",
    record: {
      model_id: m.value,
      provider: TYPESAFEAI,
      title: m.value,
      description: m.description ?? "",
      capabilities: [],
      provider_config: { model_name: m.value },
      metadata: {},
    },
    raw: m,
  }));
}

/**
 * One-shot run-fn for `["model.search"]`. Emits a single `finish` event with
 * the search results. When no credential key is provided, falls back to the
 * documented aliases rather than failing on a missing key — a catalog browser
 * should still be able to offer a model to add.
 */
export const TypeSafeAi_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, signal, emit) => {
  let models: TypeSafeModelListItem[];
  if (!input.credential_key) {
    models = TYPESAFEAI_FALLBACK;
  } else {
    models = await listTypeSafeModels(input.credential_key, signal);
  }
  models = filterLabeledModelsByQuery(models, input.query);
  emit({ type: "finish", data: { results: mapTypeSafeAiModels(models) } });
};
