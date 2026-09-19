/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/worker";
import { TYPESAFEAI } from "./TypeSafeAi_Constants";

export const TypeSafeAiModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: TYPESAFEAI,
      description: "Discriminator: TypeSafe cloud provider.",
    },
    provider_config: {
      type: "object",
      description: "TypeSafe-specific configuration.",
      properties: {
        model_name: {
          type: "string",
          description:
            "The TypeSafe model identifier or alias (e.g. 'jev-latest', 'jev-preview', 'jev-1.13.0').",
        },
        credential_key: {
          type: "string",
          format: "credential",
          description: "Key to look up in the credential store for the API key.",
          "x-ui-hidden": true,
        },
        base_url: {
          type: "string",
          description: "Base URL for the TypeSafe API. Useful for proxy servers.",
          default: "https://api.typesafe.ai",
        },
        trustedBaseUrl: {
          type: "boolean",
          description:
            "When true, accept a base_url whose hostname is not in the built-in allow-list. Use only for known-good custom enterprise gateways — otherwise an attacker can exfiltrate the API key by pointing base_url at their own server.",
          default: false,
          "x-ui-hidden": true,
        },
        rerank_concurrency: {
          type: "number",
          minimum: 1,
          description:
            "How many candidates a rerank scores at once. Each candidate is its own request, so this bounds the fan-out against the account's requests-per-minute limit.",
        },
      },
      required: ["model_name"],
      additionalProperties: false,
    },
  },
  required: ["provider", "provider_config"],
  additionalProperties: true,
} as const satisfies DataPortSchemaObject;

export const TypeSafeAiModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...TypeSafeAiModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...TypeSafeAiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type TypeSafeAiModelRecord = WithModelPricing<
  FromSchema<typeof TypeSafeAiModelRecordSchema>
>;

export const TypeSafeAiModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...TypeSafeAiModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...TypeSafeAiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type TypeSafeAiModelConfig = WithModelPricing<
  FromSchema<typeof TypeSafeAiModelConfigSchema>
>;
