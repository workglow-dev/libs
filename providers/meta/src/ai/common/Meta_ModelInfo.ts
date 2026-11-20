/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelInfoTaskInput, ModelInfoTaskOutput } from "@workglow/ai";
import { getClient, getModelName } from "./Meta_Client";
import { META } from "./Meta_Constants";
import type { MetaModelConfig } from "./Meta_ModelSchema";

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  const code = (err as { code?: unknown }).code;
  return status === 404 || statusCode === 404 || code === "model_not_found";
}

async function assertMetaModelExists(
  model: MetaModelConfig | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const modelName = getModelName(model);
  const client = await getClient(model);
  try {
    await client.models.retrieve(modelName, signal ? { signal } : undefined);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        `${META} model "${modelName}" was not found (provider API returned not found)`
      );
    }
    throw err;
  }
}

/**
 * One-shot run-fn for `["model.info"]`. Verifies the model exists via Meta's
 * OpenAI-compatible `models.retrieve`, then emits a remote info record.
 */
export const Meta_ModelInfo_Stream: AiProviderRunFn<
  ModelInfoTaskInput,
  ModelInfoTaskOutput,
  MetaModelConfig
> = async (input, model, signal, emit) => {
  await assertMetaModelExists(model, signal);
  emit({
    type: "finish",
    data: {
      model: input.model,
      is_local: false,
      is_remote: true,
      supports_browser: true,
      supports_node: true,
      is_cached: false,
      is_loaded: false,
      file_sizes: null,
    },
  });
};
