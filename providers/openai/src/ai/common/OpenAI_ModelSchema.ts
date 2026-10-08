/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/worker";
import { OPENAI } from "./OpenAI_Constants";

export const OpenAiModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: OPENAI,
      description: "Discriminator: OpenAI cloud provider.",
    },
    provider_config: {
      type: "object",
      description: "OpenAI-specific configuration.",
      properties: {
        model_name: {
          type: "string",
          description: "The OpenAI model identifier (e.g., 'gpt-4o', 'text-embedding-3-small').",
        },
        credential_key: {
          type: "string",
          format: "credential",
          description: "Key to look up in the credential store for the API key.",
          "x-ui-hidden": true,
        },
        base_url: {
          type: "string",
          description: "Base URL for the OpenAI API. Useful for Azure OpenAI or proxy servers.",
          default: "https://api.openai.com/v1",
        },
        trustedBaseUrl: {
          type: "boolean",
          description:
            "When true, accept a base_url whose hostname is not in the built-in allow-list. Use only for known-good custom enterprise gateways — otherwise an attacker can exfiltrate the API key by pointing base_url at their own server.",
          default: false,
          "x-ui-hidden": true,
        },
        organization: {
          type: "string",
          description: "OpenAI organization ID (optional).",
        },
        prompt_cache_key: {
          type: "string",
          description:
            "Overrides the auto-derived Responses prompt_cache_key. Requests sharing a key share a cached prefix; leave unset to derive a stable key from the model + system instructions + tools.",
          "x-ui-hidden": true,
        },
        reasoning: {
          type: "object",
          description:
            "Reasoning controls for reasoning-capable models (e.g. the GPT-5.6 sol/terra/luna family), sent on the Responses API.",
          properties: {
            effort: {
              type: "string",
              enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
              description: "Reasoning effort. Higher effort trades latency and cost for quality.",
            },
            mode: {
              type: "string",
              enum: ["pro"],
              description:
                "Set to 'pro' for the quality-first pro configuration on supported models.",
            },
          },
          additionalProperties: false,
        },
        accepts_temperature_with_reasoning: {
          type: "boolean",
          description:
            "Override whether the model accepts a pinned temperature with reasoning effort 'none'. Absent means 'decide from the model id'. A wrong `true` is an HTTP 400.",
          "x-ui-hidden": true,
        },
        replay_reasoning: {
          type: "boolean",
          description:
            "Hand the model its own reasoning back on later rounds (default true); false is the ablation switch.",
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

export const OpenAiModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...OpenAiModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...OpenAiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type OpenAiModelRecord = WithModelPricing<FromSchema<typeof OpenAiModelRecordSchema>>;

export const OpenAiModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...OpenAiModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...OpenAiModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type OpenAiModelConfig = WithModelPricing<FromSchema<typeof OpenAiModelConfigSchema>>;
