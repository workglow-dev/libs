/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ModelDownloadRemoveTaskRunInput,
  ModelDownloadRemoveTaskRunOutput,
} from "@workglow/ai";
import { HTF_CACHE_NAME } from "./HFT_Constants";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  disposeHftSessionsForModel,
  getPipelineCacheKey,
  loadTransformersSDK,
  removeCachedPipeline,
} from "./HFT_Pipeline";

function hasBrowserCacheStorage(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    "caches" in globalThis &&
    typeof (globalThis as unknown as { caches?: CacheStorage }).caches?.open === "function"
  );
}

/**
 * Deletes all Cache Storage entries for a given model path (browser / Service Worker).
 */
async function deleteModelCacheFromBrowser(model_path: string): Promise<void> {
  const cachesApi = (globalThis as unknown as { caches: CacheStorage }).caches;
  const cache = await cachesApi.open(HTF_CACHE_NAME);
  const keys = await cache.keys();
  const prefix = `/${model_path}/`;

  const requestsToDelete: Request[] = [];
  for (const request of keys) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(prefix)) {
      requestsToDelete.push(request);
    }
  }

  for (const request of requestsToDelete) {
    try {
      const deleted = await cache.delete(request);
      if (!deleted) {
        const deletedByUrl = await cache.delete(request.url);
        if (!deletedByUrl) {
          /* ignore */
        }
      }
    } catch (error) {
      console.error(`Failed to delete cache entry: ${request.url}`, error);
    }
  }
}

/**
 * Removes cached ONNX/tokenizer files from the filesystem (Node/Bun / worker).
 */
async function deleteModelCacheFromFilesystem(model: HfTransformersOnnxModelConfig): Promise<void> {
  const { ModelRegistry } = await loadTransformersSDK();
  const { pipeline: pipelineType, model_path, dtype } = model.provider_config;
  const options = dtype ? { dtype } : {};
  // An image-text-to-text model is no pipeline task transformers.js knows; its
  // files are the model's plus its tokenizer and processor.
  if (pipelineType === "image-text-to-text") {
    await ModelRegistry.clear_cache(model_path, options);
  } else {
    await ModelRegistry.clear_pipeline_cache(pipelineType, model_path, options);
  }
}

export const HFT_DownloadRemove: AiProviderRunFn<
  ModelDownloadRemoveTaskRunInput,
  ModelDownloadRemoveTaskRunOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, _signal, emit) => {
  // Delete the pipeline from the in-memory map. Intermediate progress callbacks dropped:
  // one-shot run-fns signal completion via the finish event.
  const cacheKey = getPipelineCacheKey(model!);
  await removeCachedPipeline(cacheKey);

  const model_path = model!.provider_config.model_path;

  // Dispose all sessions tied to this model
  disposeHftSessionsForModel(model_path);
  if (hasBrowserCacheStorage()) {
    await deleteModelCacheFromBrowser(model_path);
  } else {
    await deleteModelCacheFromFilesystem(model!);
  }

  emit({ type: "finish", data: { model: input.model! } });
};
