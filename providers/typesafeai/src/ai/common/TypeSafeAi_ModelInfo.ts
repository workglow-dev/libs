/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelInfoTaskInput, ModelInfoTaskOutput } from "@workglow/ai";
import { getModelName } from "./TypeSafeAi_Client";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";

/**
 * One-shot run-fn for `["model.info"]`.
 *
 * **No existence check is made, deliberately.** TypeSafe has no per-model
 * retrieve endpoint, and `GET /v1/models` lists only the aliases — the vendor
 * states that a versioned id such as `jev-1.13.0` is accepted by the `model`
 * field whether or not it appears there. Verifying against that list would
 * therefore reject the exact ids a caller is told to pin, so absence from the
 * catalog is not treated as evidence of a model that does not exist. A wrong
 * model name surfaces on the first real call, with the API's own message.
 *
 * The run still reads `provider_config.model_name`, so a record with no model
 * name fails here rather than at the next request.
 */
export const TypeSafeAi_ModelInfo_Stream: AiProviderRunFn<
  ModelInfoTaskInput,
  ModelInfoTaskOutput,
  TypeSafeAiModelConfig
> = async (input, model, _signal, emit) => {
  getModelName(model);
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
