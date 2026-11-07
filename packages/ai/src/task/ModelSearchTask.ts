/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreateWorkflow, Task, TaskConfigurationError, Workflow } from "@workglow/task-graph";

import type { CachePolicy, IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { accumulatingEmit } from "../capability/accumulatingEmit";
import type { Capability } from "../capability/Capabilities";
import type { ModelRecord } from "../model/ModelSchema";
import { getAiProviderRegistry } from "../provider/AiProviderRegistry";
import { TypeModel } from "./base/AiTaskSchemas";

/**
 * A single result item from a model search.
 */
export interface ModelSearchResultItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly record: Partial<ModelRecord>;
  readonly raw: unknown;
}

/** Static input schema (serialization, typing). Enum/labels for `provider` are added at runtime via {@link ModelSearchTask.inputSchema}. */
const ModelSearchInputSchema = {
  type: "object",
  properties: {
    provider: {
      type: "string",
      title: "Provider",
      description:
        "Registered AI provider id to use for model search. At runtime the workflow UI lists only providers that support model search.",
    },
    query: {
      type: "string",
      title: "Query",
      description:
        "Optional search string. When omitted or empty, returns all models (provider-specific listing).",
    },
    credential_key: {
      type: "string",
      title: "Credential",
      description:
        "Optional credential-store key used to list provider models. When omitted, providers may return a curated fallback list.",
      format: "credential",
      "x-ui-hidden": true,
    },
  },
  required: ["provider"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

function buildModelSearchInputSchemaDynamic(): DataPortSchema {
  const registry = getAiProviderRegistry();
  const ids = registry.getProviderIdsForCapabilities(["model.search"]);
  const enumLabels: Record<string, string> = {};
  for (const id of ids) {
    enumLabels[id] = registry.getProvider(id)?.displayName ?? id;
  }
  const providerProp: Record<string, unknown> = {
    ...ModelSearchInputSchema.properties.provider,
  };
  if (ids.length > 0) {
    providerProp.enum = ids;
    providerProp["x-ui-enum-labels"] = enumLabels;
  }
  return {
    type: "object",
    properties: {
      provider: providerProp,
      query: ModelSearchInputSchema.properties.query,
      credential_key: ModelSearchInputSchema.properties.credential_key,
    },
    required: [...ModelSearchInputSchema.required],
    additionalProperties: ModelSearchInputSchema.additionalProperties,
  } as DataPortSchema;
}

const ModelSearchOutputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          record: TypeModel("model"),
          raw: {},
        },
        required: ["id", "label", "description", "record"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ModelSearchTaskInput = {
  credential_key?: string | undefined;
  query?: string | undefined;
  provider: string;
};
export type ModelSearchTaskOutput = { results: ModelSearchResultItem[] };
export type ModelSearchTaskConfig = TaskConfig<ModelSearchTaskInput>;

/**
 * Search for models using a provider-specific run function from the AiProviderRegistry.
 */
export class ModelSearchTask extends Task<
  ModelSearchTaskInput,
  ModelSearchTaskOutput,
  ModelSearchTaskConfig
> {
  public static override type = "ModelSearchTask";
  /**
   * Informational: capability this task uses. NOT enforced by the dispatcher —
   * ModelSearchTask extends `Task` (not `AiTask`) and implements its own
   * `execute()`, so `gateOrThrow` is never called against this value. The audit
   * test in `task/index.test.ts` validates the value is a known {@link Capability}.
   */
  public static readonly requires: readonly Capability[] = [
    "model.search",
  ] as const satisfies Capability[];
  public static override category = "AI Model";
  public static override title = "Model Search";
  public static override description = "Search for models using provider-specific search functions";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicSchemas = true;

  public static override inputSchema(): DataPortSchema {
    return ModelSearchInputSchema satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return ModelSearchOutputSchema satisfies DataPortSchema;
  }

  public override inputSchema(): DataPortSchema {
    return buildModelSearchInputSchemaDynamic();
  }

  override async execute(
    input: ModelSearchTaskInput,
    context: IExecuteContext
  ): Promise<ModelSearchTaskOutput> {
    const registry = getAiProviderRegistry();
    const runFn = registry.getRunFnFor<ModelSearchTaskInput, ModelSearchTaskOutput>(
      input.provider,
      ["model.search"]
    );
    if (!runFn) {
      throw new TaskConfigurationError(
        `Provider "${input.provider}" has no run function serving "model.search".`
      );
    }
    const { emit, result } = accumulatingEmit<ModelSearchTaskOutput>();
    await runFn(input, undefined, context.signal, emit);
    return result();
  }
}

/**
 * Search for models using a provider-specific search function.
 */
export const modelSearch = (
  input: ModelSearchTaskInput,
  config?: ModelSearchTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new ModelSearchTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    modelSearch: CreateWorkflow<ModelSearchTaskInput, ModelSearchTaskOutput, ModelSearchTaskConfig>;
  }
}

Workflow.prototype.modelSearch = CreateWorkflow(ModelSearchTask);
