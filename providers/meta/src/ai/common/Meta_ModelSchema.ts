/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/worker";
import { META } from "./Meta_Constants";

export const MetaModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: META,
      description: "Discriminator: Meta Model API (Muse) cloud provider.",
    },
    provider_config: {
      type: "object",
      description: "Meta-specific configuration.",
      properties: {
        model_name: {
          type: "string",
          description: "The Meta model identifier (e.g., 'muse-spark-1.3', 'muse-wonder-1.0').",
        },
        credential_key: {
          type: "string",
          format: "credential",
          description: "Key to look up in the credential store for the API key.",
          "x-ui-hidden": true,
        },
        base_url: {
          type: "string",
          description: "Base URL for the Meta Model API. Useful for proxy servers.",
          default: "https://api.meta.ai/v1",
        },
        trustedBaseUrl: {
          type: "boolean",
          description:
            "When true, accept a base_url whose hostname is not in the built-in allow-list. Use only for known-good custom enterprise gateways — otherwise an attacker can exfiltrate the API key by pointing base_url at their own server.",
          default: false,
          "x-ui-hidden": true,
        },
        reasoning_effort: {
          type: "string",
          description:
            "Native Meta reasoning effort (minimal, low, medium, high, xhigh, max). When set, wins over the coarse model.effort dial.",
          "x-ui-hidden": true,
        },
      },
      required: ["model_name"],
      additionalProperties: false,
    },
  },
  required: ["provider", "provider_config"],
  additionalProperties: true,
} as const satisfies DataPortSchemaObject;

export const MetaModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...MetaModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...MetaModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type MetaModelRecord = WithModelPricing<FromSchema<typeof MetaModelRecordSchema>>;

export const MetaModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...MetaModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...MetaModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type MetaModelConfig = WithModelPricing<FromSchema<typeof MetaModelConfigSchema>>;
