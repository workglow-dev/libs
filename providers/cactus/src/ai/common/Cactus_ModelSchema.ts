/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WithModelPricing } from "@workglow/ai/worker";
import { ModelConfigSchema, ModelRecordSchema } from "@workglow/ai/worker";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/schema";
import {
  CACTUS_DEFAULT_MODELS_DIR,
  CACTUS_NEEDLE_26M,
  CACTUS_NEEDLE_V2,
  CACTUS_NEEDLE_V3,
  LOCAL_CACTUS,
} from "./Cactus_Constants";

export const CactusModelSchema = {
  type: "object",
  properties: {
    provider: {
      const: LOCAL_CACTUS,
      description: "Discriminator: local needle-rs (Cactus) model.",
    },
    provider_config: {
      type: "object",
      description: "Cactus-specific configuration.",
      properties: {
        model_id: {
          type: "string",
          enum: [CACTUS_NEEDLE_26M, CACTUS_NEEDLE_V2, CACTUS_NEEDLE_V3],
          description: "Catalog id of the Cactus model.",
        },
        models_dir: {
          type: "string",
          description:
            "Node/Bun on-disk cache directory. Ignored in the browser (Cache Storage is used).",
          default: CACTUS_DEFAULT_MODELS_DIR,
        },
      },
      required: ["model_id"],
      additionalProperties: false,
    },
  },
  required: ["provider", "provider_config"],
  additionalProperties: true,
} as const satisfies DataPortSchemaObject;

export const CactusModelRecordSchema = {
  type: "object",
  properties: {
    ...ModelRecordSchema.properties,
    ...CactusModelSchema.properties,
  },
  required: [...ModelRecordSchema.required, ...CactusModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type CactusModelRecord = WithModelPricing<FromSchema<typeof CactusModelRecordSchema>>;

export const CactusModelConfigSchema = {
  type: "object",
  properties: {
    ...ModelConfigSchema.properties,
    ...CactusModelSchema.properties,
  },
  required: [...ModelConfigSchema.required, ...CactusModelSchema.required],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type CactusModelConfig = WithModelPricing<FromSchema<typeof CactusModelConfigSchema>>;
