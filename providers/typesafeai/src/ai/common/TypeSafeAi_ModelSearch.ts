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
import { getClient } from "./TypeSafeAi_Client";
import { TYPESAFEAI } from "./TypeSafeAi_Constants";
import {
  resolveTypeSafeAiProfile,
  typeSafeAiProfileCapabilities,
} from "./TypeSafeAi_ModelProfiles";

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
    description:
      "Preview the next version of Jev before it gets promoted to jev-latest. Most of the time this is the same as jev-latest",
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

/** What the profile table says a listed model serves; nothing for an id it does not recognize. */
function listedCapabilities(modelName: string): Capability[] {
  const { profile, recognized } = resolveTypeSafeAiProfile(modelName);
  return recognized ? [...typeSafeAiProfileCapabilities(profile)] : [];
}

/**
 * Build the record a search result seeds a catalog entry with.
 *
 * `capabilities` comes from the profile table, the same answer the provider's
 * own `inferCapabilities` gives a record typed in by hand, so the two paths
 * cannot disagree about the same model; an id the table does not recognize is
 * left empty for inference to fill.
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
      capabilities: listedCapabilities(m.value),
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
