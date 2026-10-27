/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelInfoTaskInput, ModelInfoTaskOutput } from "@workglow/ai";
import { resolveOllamaProfile } from "./Ollama_ModelProfiles";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";
import { getOllamaModelName } from "./Ollama_ModelUtil";

type GetClient = (model: OllamaModelConfig | undefined) => Promise<any>;

export function createOllamaModelInfoStream(
  getClient: GetClient
): AiProviderRunFn<ModelInfoTaskInput, ModelInfoTaskOutput, OllamaModelConfig> {
  return async (input, model, signal, emit) => {
    if (input.detail === "dimensions") {
      if (!model) throw new Error("Model config is required for ModelInfoTask.");
      const pc = model.provider_config as Record<string, unknown>;
      let native_dimensions =
        typeof pc.native_dimensions === "number" ? pc.native_dimensions : undefined;
      let mrl = typeof pc.mrl === "boolean" ? pc.mrl : undefined;

      if (native_dimensions === undefined) {
        try {
          const client = await getClient(model);
          const modelName = getOllamaModelName(model);
          const info = await client.show({ model: modelName });
          const details = info?.details as Record<string, unknown> | undefined;
          if (typeof details?.embedding_length === "number") {
            native_dimensions = details.embedding_length;
          }
        } catch {
          // Model not available — fall through to lookup table.
        }
      }

      if (native_dimensions === undefined) {
        const { profile } = resolveOllamaProfile(
          typeof pc.model_name === "string" ? pc.model_name : undefined
        );
        const known = profile.kind === "embedding" ? profile.dimensions : undefined;
        if (known) {
          native_dimensions = known.native;
          mrl = mrl ?? known.mrl;
        }
      }

      emit({
        type: "finish",
        data: {
          model: input.model,
          is_local: true,
          is_remote: false,
          supports_browser: true,
          supports_node: true,
          is_cached: false,
          is_loaded: false,
          file_sizes: null,
          ...(native_dimensions !== undefined ? { native_dimensions } : {}),
          ...(mrl !== undefined ? { mrl } : {}),
        } as ModelInfoTaskOutput,
      });
      return;
    }

    const client = await getClient(model);
    const modelName = getOllamaModelName(model);

    let is_cached = false;
    let is_loaded = false;
    let file_sizes: Record<string, number> | null = null;

    try {
      const showResponse = await client.show({ model: modelName });
      is_cached = true;
      const size = showResponse.size;
      if (size != null) {
        file_sizes = { model: size };
      }
    } catch {
      // Model not available on server
    }

    try {
      const psResponse = await client.ps();
      is_loaded = psResponse.models.some((m: { name: string }) => m.name === modelName);
    } catch {
      // ps() not available or failed
    }

    emit({
      type: "finish",
      data: {
        model: input.model,
        is_local: true,
        is_remote: false,
        supports_browser: true,
        supports_node: true,
        is_cached,
        is_loaded,
        file_sizes,
      },
    });
  };
}
