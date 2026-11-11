/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/worker";
import { GOOGLE_GEMINI } from "./Gemini_Constants";

export const GeminiModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: GOOGLE_GEMINI,
      description: "Discriminator: Google Gemini cloud provider.",
    },
    provider_config: {
      type: "object",
      description: "Google Gemini-specific configuration.",
      properties: {
        model_name: {
          type: "string",
          description:
            "The Gemini model identifier (e.g., 'gemini-2.0-flash', 'text-embedding-004').",
        },
        credential_key: {
          type: "string",
          format: "credential",
          description: "Key to look up in the credential store for the API key.",
          "x-ui-hidden": true,
        },
        embedding_task_type: {
          oneOf: [
            { type: "null" },
            {
              type: "string",
              enum: [
                "RETRIEVAL_QUERY",
                "RETRIEVAL_DOCUMENT",
                "SEMANTIC_SIMILARITY",
                "CLASSIFICATION",
                "CLUSTERING",
              ],
            },
          ],
          description: "Task type hint for embedding models.",
          default: null,
        },
        seed: {
          type: "number",
          description:
            "RNG seed passed to Gemini sampling. Omit for non-reproducible generation; " +
            "set for reproducible generation. Matches the local providers' `seed` " +
            "(node-llama-cpp, transformers.js), which name the same knob.",
        },
        thinking_budget: {
          type: "number",
          description:
            "Reasoning token allowance for thinking models (2.5+/3.x). Gemini counts " +
            "thinking tokens against maxOutputTokens, so the provider pads the output cap " +
            "by this budget to leave room for the answer. 0 disables thinking; -1 lets the " +
            "model choose. Wins over model.effort when set.",
        },
        thinking_level: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description:
            "Thinking depth for Gemini 3 and later, where it is also what model.effort maps " +
            "to; ignored on earlier models, which only take thinking_budget. Wins over " +
            "model.effort and thinking_budget. The output cap is not padded: thinking " +
            "counts against maxTokens, and xhigh can spend a lot of it.",
        },
      },
      required: ["model_name"],
      additionalProperties: false,
    },
  },
  required: ["provider", "provider_config"],
  additionalProperties: true,
} as const satisfies DataPortSchemaObject;

export const GeminiModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...GeminiModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...GeminiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type GeminiModelRecord = WithModelPricing<FromSchema<typeof GeminiModelRecordSchema>>;

export const GeminiModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...GeminiModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...GeminiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type GeminiModelConfig = WithModelPricing<FromSchema<typeof GeminiModelConfigSchema>>;
