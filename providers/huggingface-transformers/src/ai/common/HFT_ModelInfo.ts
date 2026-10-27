/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DeviceType } from "@huggingface/transformers";
import type { AiProviderRunFn, ModelInfoTaskInput, ModelInfoTaskOutput } from "@workglow/ai";
import { getLogger } from "@workglow/util/worker";
import { resolveHftPipelineDevice } from "./HFT_Device";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import { parseOnnxQuantizations } from "./HFT_OnnxDtypes";
import { getPipelineCacheKey, hasCachedPipeline, loadTransformersSDK } from "./HFT_Pipeline";

export const HFT_ModelInfo: AiProviderRunFn<
  ModelInfoTaskInput,
  ModelInfoTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, _signal, emit) => {
  // Handle dimensions detail — resolve native_dimensions and mrl
  if (input.detail === "dimensions") {
    if (!model) throw new Error("Model config is required for ModelInfoTask.");
    const pc = model.provider_config as Record<string, unknown>;
    let native_dimensions =
      typeof pc.native_dimensions === "number" ? pc.native_dimensions : undefined;
    const mrl = typeof pc.mrl === "boolean" ? pc.mrl : false;

    // Step 2: If not in provider_config, try fetching config.json from HF hub
    if (native_dimensions === undefined && typeof pc.model_path === "string") {
      try {
        const response = await fetch(
          `https://huggingface.co/${pc.model_path}/resolve/${(pc.revision as string) ?? "main"}/config.json`
        );
        if (response.ok) {
          const config = await response.json();
          if (typeof config.hidden_size === "number") {
            native_dimensions = config.hidden_size;
          }
        }
      } catch {
        // Network error — fall through to undefined
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
        ...(mrl ? { mrl } : {}),
      },
    });
    return;
  }

  const logger = getLogger();
  const { ModelRegistry } = await loadTransformersSDK();
  const timerLabel = `hft:ModelInfo:${model?.provider_config.model_path}`;
  logger.time(timerLabel, { model: model?.provider_config.model_path });

  const detail = input.detail;
  const is_loaded = hasCachedPipeline(getPipelineCacheKey(model!));

  const { pipeline: pipelineType, model_path, dtype } = model!.provider_config;
  const device = resolveHftPipelineDevice(model!.provider_config.device);

  const cacheOptions = {
    ...(dtype ? { dtype } : {}),
    ...(device ? { device: device as DeviceType } : {}),
  };
  // An image-text-to-text model is no pipeline task transformers.js knows, so
  // its files are the model's plus its tokenizer and processor — the parts
  // getPipeline loads for it.
  const cacheStatus =
    pipelineType === "image-text-to-text"
      ? await ModelRegistry.is_cached_files(model_path, cacheOptions)
      : await ModelRegistry.is_pipeline_cached_files(pipelineType, model_path, cacheOptions);
  logger.debug("is_pipeline_cached", {
    input: [pipelineType, model_path, cacheOptions],
    result: cacheStatus,
  });
  const is_cached = is_loaded || cacheStatus.allCached;

  // Build file_sizes based on requested detail level
  let file_sizes: Record<string, number> | null = null;
  if (detail === "files" && cacheStatus.files.length > 0) {
    // Return file names with zero sizes (no network calls)
    const sizes: Record<string, number> = {};
    for (const { file } of cacheStatus.files) {
      sizes[file] = 0;
    }
    file_sizes = sizes;
  } else if (detail === "files_with_metadata" && cacheStatus.files.length > 0) {
    // Full metadata fetch per file (N network calls)
    const sizes: Record<string, number> = {};
    await Promise.all(
      cacheStatus.files.map(async ({ file }) => {
        const metadata = await ModelRegistry.get_file_metadata(model_path, file);
        if (metadata.exists && metadata.size !== undefined) {
          sizes[file] = metadata.size;
        }
      })
    );
    if (Object.keys(sizes).length > 0) {
      file_sizes = sizes;
    }
  }

  // Parse ONNX quantizations from file list
  let quantizations: string[] | undefined;
  if (cacheStatus.files.length > 0) {
    const filePaths = cacheStatus.files.map((f) => f.file);
    const quantizations_parsed = parseOnnxQuantizations({ filePaths });
    if (quantizations_parsed.length > 0) {
      quantizations = quantizations_parsed;
    }
  }

  logger.timeEnd(timerLabel, { model: model?.provider_config.model_path });

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
      ...(quantizations ? { quantizations } : {}),
    },
  });
};
