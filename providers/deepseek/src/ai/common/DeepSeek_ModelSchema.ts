/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/worker";
import { DEEPSEEK } from "./DeepSeek_Constants";

export const DeepSeekModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: DEEPSEEK,
      description: "Discriminator: DeepSeek cloud provider.",
    },
    provider_config: {
      type: "object",
      description: "DeepSeek-specific configuration.",
      properties: {
        model_name: {
          type: "string",
          description: "The DeepSeek model identifier (e.g., 'deepseek-flash', 'deepseek-v4-pro').",
        },
        credential_key: {
          type: "string",
          format: "credential",
          description: "Key to look up in the credential store for the API key.",
          "x-ui-hidden": true,
        },
        base_url: {
          type: "string",
          description: "Base URL for the DeepSeek API. Useful for proxy servers.",
          default: "https://api.deepseek.com",
        },
        trustedBaseUrl: {
          type: "boolean",
          description:
            "When true, accept a base_url whose hostname is not in the built-in allow-list. Use only for known-good custom enterprise gateways — otherwise an attacker can exfiltrate the API key by pointing base_url at their own server.",
          default: false,
          "x-ui-hidden": true,
        },
        reasoning_allowance: {
          type: "number",
          minimum: 0,
          description:
            "Tokens added to the answer budget to leave room for reasoning. Set 0 for a non-thinking model; omit for the default.",
        },
        replay_reasoning: {
          type: "boolean",
          description:
            "Send each assistant turn's reasoning back on later rounds of a tool-calling loop (default true). Off saves the prompt tokens it costs, at the price of the model working its plan out again each round.",
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

export const DeepSeekModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...DeepSeekModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...DeepSeekModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type DeepSeekModelRecord = WithModelPricing<FromSchema<typeof DeepSeekModelRecordSchema>>;

export const DeepSeekModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...DeepSeekModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...DeepSeekModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type DeepSeekModelConfig = WithModelPricing<FromSchema<typeof DeepSeekModelConfigSchema>>;
