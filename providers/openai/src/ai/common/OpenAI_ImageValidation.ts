/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";
import { AiImageOutputTask, ProviderUnsupportedFeatureError } from "@workglow/ai";

import { OPENAI } from "./OpenAI_Constants";
import { resolveOpenAiProfile } from "./OpenAI_ModelProfiles";

/**
 * Registers the OpenAI per-provider image validator. Called at provider registration time
 * (both inline and worker-backed paths) so it runs on the main thread before any dispatch.
 *
 * Currently validates:
 * - DALL-E 2 + non-empty `additionalImages` → throws (single-image edit only).
 *   DALL-E 3 + ImageEditTask is rejected upstream by the model registry task-array check.
 */
export function registerOpenAiImageValidator(): void {
  AiImageOutputTask.registerProviderImageValidator(
    OPENAI,
    (taskType, input, model: ModelConfig) => {
      if (taskType !== "ImageEditTask") return;
      const modelName =
        (model.provider_config as { model_name?: string } | undefined)?.model_name ?? "";
      const additional = input["additionalImages"] as unknown[] | undefined;
      const { profile } = resolveOpenAiProfile(modelName);
      const singleImage = profile.kind === "image" && profile.editing === "single";
      if (singleImage && Array.isArray(additional) && additional.length > 0) {
        throw new ProviderUnsupportedFeatureError(
          "additionalImages",
          model.model_id ?? modelName,
          "DALL-E 2 only supports single-image edits"
        );
      }
    }
  );
}
