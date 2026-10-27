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
import { normalizedModelSearchQuery } from "@workglow/ai/provider-utils";
import type { Capability } from "@workglow/ai/worker";
import { stampEffortOptions } from "@workglow/ai/worker";
import { GOOGLE_GEMINI } from "./Gemini_Constants";
import { geminiEffortPolicy } from "./Gemini_EffortPolicy";
import { geminiProfileCapabilities, resolveGeminiProfile } from "./Gemini_ModelProfiles";

interface GeminiModelEntry {
  readonly label: string;
  readonly value: string;
}

export const GEMINI_FALLBACK_MODELS: readonly GeminiModelEntry[] = [
  { label: "gemini-3.8-flash", value: "gemini-3.8-flash" },
  { label: "gemini-3.1-pro-preview", value: "gemini-3.1-pro-preview" },
  { label: "gemini-3.1-flash-lite", value: "gemini-3.1-flash-lite" },
  // Embedding models
  { label: "gemini-embedding-2", value: "gemini-embedding-2" },
  // Image-output models
  { label: "gemini-3.1-flash-image", value: "gemini-3.1-flash-image" },
  { label: "gemini-3-pro-image", value: "gemini-3-pro-image" },
  { label: "imagen-4.0-generate-001", value: "imagen-4.0-generate-001" },
];

interface GeminiApiModel {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly supportedGenerationMethods?: readonly string[];
}

/** What the profile table says a listed model serves; nothing for an id it does not recognize. */
function listedCapabilities(id: string): Capability[] {
  const { profile, recognized } = resolveGeminiProfile(id);
  return recognized ? [...geminiProfileCapabilities(profile)] : [];
}

/**
 * The profile answers for an id it recognizes; for the rest the API's own
 * `supportedGenerationMethods` can still say a model embeds.
 */
function capabilitiesForGeminiApiModel(model: GeminiApiModel, id: string): string[] {
  const listed = listedCapabilities(id);
  if (listed.length > 0) return listed;

  const methods = model.supportedGenerationMethods ?? [];
  if (methods.some((method) => method.toLowerCase().includes("embed"))) {
    return ["text.embedding"];
  }
  return [];
}

function mapGeminiModel(model: GeminiApiModel): ModelSearchResultItem {
  const id = model.name.startsWith("models/") ? model.name.slice("models/".length) : model.name;
  const title = model.displayName || id;
  return {
    id,
    label: title,
    description: model.displayName ? id : (model.description ?? ""),
    record: stampEffortOptions(
      {
        model_id: id,
        provider: GOOGLE_GEMINI,
        title,
        description: model.description ?? "",
        capabilities: capabilitiesForGeminiApiModel(model, id),
        provider_config: { model_name: id },
        metadata: {},
      },
      geminiEffortPolicy({
        provider: GOOGLE_GEMINI,
        provider_config: { model_name: id },
      })
    ),
    raw: model,
  };
}

async function listGeminiModels(
  credentialKey: string,
  signal?: AbortSignal
): Promise<ModelSearchResultItem[]> {
  const params = new URLSearchParams({ key: credentialKey });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?${params}`,
    {
      signal,
    }
  );
  if (!response.ok) throw new Error(`Gemini API returned ${response.status}`);
  const body = (await response.json()) as { models?: GeminiApiModel[] };
  return (body.models ?? []).map(mapGeminiModel);
}

export const Gemini_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, signal, emit) => {
  const q = normalizedModelSearchQuery(input.query);
  if (input.credential_key) {
    const models = await listGeminiModels(input.credential_key, signal);
    const results = q
      ? models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : models;
    emit({ type: "finish", data: { results } });
    return;
  }

  const filtered = q
    ? GEMINI_FALLBACK_MODELS.filter(
        (m) => m.value.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
      )
    : GEMINI_FALLBACK_MODELS;
  const results: ModelSearchResultItem[] = filtered.map((m) => ({
    id: m.value,
    label: m.label,
    description: "",
    record: stampEffortOptions(
      {
        model_id: m.value,
        provider: GOOGLE_GEMINI,
        title: m.value,
        description: "",
        capabilities: listedCapabilities(m.value),
        provider_config: { model_name: m.value },
        metadata: {},
      },
      geminiEffortPolicy({
        provider: GOOGLE_GEMINI,
        provider_config: { model_name: m.value },
      })
    ),
    raw: m,
  }));
  emit({ type: "finish", data: { results } });
};
