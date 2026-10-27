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
import { openRouterModelCapabilities } from "./OpenRouter_Capabilities";
import { OPENROUTER } from "./OpenRouter_Constants";
import { openrouterEffortPolicy } from "./OpenRouter_EffortPolicy";

export interface OpenRouterRawModel {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly context_length?: number;
  readonly pricing?: Record<string, unknown>;
  readonly architecture?: {
    readonly input_modalities?: readonly string[];
    readonly output_modalities?: readonly string[];
    readonly modality?: string;
  };
  readonly supported_parameters?: readonly string[];
}

/** Minimal curated fallback used when the public /models fetch fails. */
export const OPENROUTER_FALLBACK_MODELS: OpenRouterRawModel[] = [
  {
    id: "openai/gpt-5",
    name: "OpenAI: GPT-5",
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "response_format"],
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "response_format"],
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Google: Gemini 2.5 Pro",
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "response_format"],
  },
];

export async function fetchOpenRouterModels(
  baseUrl = "https://openrouter.ai/api/v1",
  signal?: AbortSignal
): Promise<OpenRouterRawModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal });
    if (!res.ok) return OPENROUTER_FALLBACK_MODELS;
    const body = (await res.json()) as { data?: OpenRouterRawModel[] };
    return Array.isArray(body.data) && body.data.length > 0
      ? body.data
      : OPENROUTER_FALLBACK_MODELS;
  } catch (err) {
    // Propagate a genuine cancellation instead of masking it as a fallback
    // result; only degrade to the curated list on network/parse failures.
    if (signal?.aborted) throw err;
    return OPENROUTER_FALLBACK_MODELS;
  }
}

export function mapOpenRouterModels(raw: readonly OpenRouterRawModel[]): ModelSearchResultItem[] {
  return raw.map((m) => {
    const capabilities = openRouterModelCapabilities(m.id, {
      architecture: m.architecture,
      supported_parameters: m.supported_parameters,
    });
    return {
      id: m.id,
      label: m.name ?? m.id,
      description: m.description ?? "",
      record: stampEffortOptions(
        {
          model_id: m.id,
          provider: OPENROUTER,
          title: m.name ?? m.id,
          description: m.description ?? "",
          capabilities: [...capabilities],
          provider_config: { model_name: m.id },
          metadata: {
            context_length: m.context_length,
            pricing: m.pricing,
            architecture: m.architecture,
            supported_parameters: m.supported_parameters,
          },
        },
        openrouterEffortPolicy({
          provider: OPENROUTER,
          provider_config: { model_name: m.id },
        })
      ),
      raw: m,
    };
  });
}

/**
 * One-shot run-fn for `["model.search"]`. Fetches OpenRouter's public /models
 * endpoint (no key required), maps entries to result records with data-driven
 * capabilities, and filters by query. Degrades to a curated list on failure.
 */
export const OpenRouter_ModelSearch_Stream: AiProviderRunFn<
  ModelSearchTaskInput,
  ModelSearchTaskOutput
> = async (input, _model, signal, emit) => {
  const raw = await fetchOpenRouterModels(undefined, signal);
  const labeled = raw.map((m) => ({ label: m.name ?? m.id, value: m.id, raw: m }));
  const filtered = filterLabeledModelsByQuery(labeled, input.query);
  const results = mapOpenRouterModels(filtered.map((f) => f.raw));
  emit({ type: "finish", data: { results } });
};
