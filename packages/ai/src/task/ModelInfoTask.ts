/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreateWorkflow, TaskConfigurationError, Workflow } from "@workglow/task-graph";

import type { CachePolicy, IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { accumulatingEmit } from "../capability/accumulatingEmit";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import { getAiProviderRegistry } from "../provider/AiProviderRegistry";
import { AiTask } from "./base/AiTask";
import { TypeModel } from "./base/AiTaskSchemas";

const modelSchema = TypeModel("model");

const ModelInfoInputSchema = {
  type: "object",
  properties: {
    model: modelSchema,
    detail: {
      type: "string",
      enum: ["cached_status", "files", "files_with_metadata", "dimensions"],
      default: "files_with_metadata",
    },
  },
  required: ["model"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const ModelInfoOutputSchema = {
  type: "object",
  properties: {
    model: modelSchema,
    is_local: { type: "boolean" },
    is_remote: { type: "boolean" },
    supports_browser: { type: "boolean" },
    supports_node: { type: "boolean" },
    is_cached: { type: "boolean" },
    is_loaded: { type: "boolean" },
    is_downloading: {
      type: "boolean",
      description:
        "Whether the runtime is actively downloading the model. Only present when a provider can report it.",
    },
    file_sizes: {},
    quantizations: {
      type: "array",
      items: { type: "string" },
      description:
        "Available quantization variants (e.g. fp32, fp16, q8). Only present for models with quantization options.",
    },
    native_dimensions: {
      type: "integer",
      description:
        "Native output vector dimensions. Only present when detail is 'dimensions' and the provider can determine them.",
    },
    mrl: {
      type: "boolean",
      description:
        "Whether the model supports Matryoshka Representation Learning. Only present when detail is 'dimensions'.",
    },
  },
  required: [
    "model",
    "is_local",
    "is_remote",
    "supports_browser",
    "supports_node",
    "is_cached",
    "is_loaded",
    "file_sizes",
  ],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ModelInfoTaskInput = {
  detail?: "cached_status" | "files" | "files_with_metadata" | "dimensions" | undefined;
  model: string | ModelConfig;
};
export type ModelInfoTaskOutput = {
  native_dimensions?: number | undefined;
  mrl?: boolean | undefined;
  is_downloading?: boolean | undefined;
  quantizations?: string[] | undefined;
  model: string | ModelConfig;
  is_local: boolean;
  is_remote: boolean;
  supports_browser: boolean;
  supports_node: boolean;
  is_cached: boolean;
  is_loaded: boolean;
  file_sizes: unknown;
};
export type ModelInfoTaskConfig = TaskConfig<ModelInfoTaskInput>;

/**
 * Retrieve runtime metadata about a model: locality, browser support, cache status, and file sizes.
 */
export class ModelInfoTask extends AiTask<
  ModelInfoTaskInput,
  ModelInfoTaskOutput,
  ModelInfoTaskConfig
> {
  public static override type = "ModelInfoTask";
  /** Capabilities required of the model; gated in {@link AiTask.execute}. */
  public static override readonly requires = ["model.info"] as const satisfies Capability[];
  public static override category = "AI Model";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override title = "Model Info";
  public static override description =
    "Returns runtime information about a model including locality, cache status, and file sizes";
  public static override inputSchema(): DataPortSchema {
    return ModelInfoInputSchema satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return ModelInfoOutputSchema satisfies DataPortSchema;
  }

  override async execute(
    input: ModelInfoTaskInput,
    context: IExecuteContext
  ): Promise<ModelInfoTaskOutput> {
    const model = input.model as ModelConfig;
    const registry = getAiProviderRegistry();
    const runFn = registry.getRunFnFor<ModelInfoTaskInput, ModelInfoTaskOutput>(model.provider, [
      "model.info",
    ]);
    if (!runFn) {
      throw new TaskConfigurationError(
        `Provider "${model.provider}" has no run function serving "model.info".`
      );
    }
    const { emit, result } = accumulatingEmit<ModelInfoTaskOutput>();
    await runFn(input, model, context.signal, emit);
    return result();
  }
}

/**
 * Retrieve runtime metadata about a model.
 *
 * @param input - Input containing the model to query
 * @returns Promise resolving to model info including locality and cache status
 */
export const modelInfo = (
  input: ModelInfoTaskInput,
  config?: ModelInfoTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new ModelInfoTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    modelInfo: CreateWorkflow<ModelInfoTaskInput, ModelInfoTaskOutput, ModelInfoTaskConfig>;
  }
}

Workflow.prototype.modelInfo = CreateWorkflow(ModelInfoTask);
