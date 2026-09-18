/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  IExecutePreviewContext,
  TaskConfig,
  TaskEntitlement,
  TaskEntitlements,
  TaskInput,
  TaskOutput,
} from "@workglow/task-graph";
import {
  Entitlements,
  Task,
  TaskConfigSchema,
  TaskConfigurationError,
  TaskError,
  TaskRegistry,
  hasStructuredOutput,
} from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { asText, getLogger } from "@workglow/util";
import type { DataPortSchema, JsonSchema } from "@workglow/util/schema";

import { accumulatingEmit } from "../../capability/accumulatingEmit";
import type { AiEmit } from "../../capability/AiEmit";
import { noopEmit } from "../../capability/AiEmit";
import type { Capability } from "../../capability/Capabilities";
import { readUsage, recordUsageTelemetry } from "../../capability/UsageTelemetry";
import type { AiJobInput } from "../../job/AiJob";
import { AiJob } from "../../job/AiJob";
import { getGlobalModelRepository } from "../../model/ModelRegistry";
import type { ModelConfig } from "../../model/ModelSchema";
import { getAiProviderRegistry } from "../../provider/AiProviderRegistry";

function schemaFormat(schema: JsonSchema): string | undefined {
  return typeof schema === "object" && schema !== null && "format" in schema
    ? schema.format
    : undefined;
}

function modelSemanticFromPropertySchema(schema: JsonSchema): string | undefined {
  const direct = schemaFormat(schema);
  if (direct === "model" || direct?.startsWith("model:")) {
    return direct;
  }
  if (typeof schema === "object" && schema !== null) {
    const branches =
      ("oneOf" in schema && Array.isArray(schema.oneOf) ? schema.oneOf : undefined) ??
      ("anyOf" in schema && Array.isArray(schema.anyOf) ? schema.anyOf : undefined);
    if (branches) {
      for (const branch of branches) {
        const semantic = modelSemanticFromPropertySchema(branch as JsonSchema);
        if (semantic) return semantic;
      }
    }
  }
  return undefined;
}

function requiresForModelProperty(
  propertySchema: JsonSchema,
  hostTaskClass: typeof AiTask
): readonly Capability[] {
  const semantic = modelSemanticFromPropertySchema(propertySchema);
  if (semantic?.startsWith("model:")) {
    const referencedTaskType = semantic.slice("model:".length);
    const ctor = TaskRegistry.all.get(referencedTaskType) as typeof AiTask | undefined;
    if (ctor) {
      return ctor.requires;
    }
  }
  return hostTaskClass.requires;
}

function modelMeetsRequires(model: ModelConfig, requires: readonly Capability[]): boolean {
  if (requires.length === 0) return true;
  const capabilities = model.capabilities as readonly string[] | undefined;
  if (!Array.isArray(capabilities) || capabilities.length === 0) return true;
  return requires.every((r) => capabilities.includes(r));
}

const aiTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export interface AiTaskInput extends TaskInput {
  model: string | ModelConfig;
}

/**
 * A base class for AI related tasks that use an execution strategy
 * (direct or queued) determined by the provider at registration time.
 *
 * Model resolution is handled automatically by the TaskRunner before execution.
 * By the time execute() is called, input.model is always a ModelConfig object.
 */
/**
 * A copy of `input` whose tool definitions carry no `execute` function.
 *
 * A job input is handed to the queue and, for a worker-backed provider, crosses
 * `postMessage` — structured clone, which throws `DataCloneError` on a function
 * and takes the whole run down with it. A host tool's `execute` is a live
 * closure over main-thread state (the conversation store, an abort signal,
 * report callbacks), so it can never be cloned — and it never needs to be: a
 * provider reads only the model-facing half of a definition, and tools are
 * executed by `AgentTask` on the thread that owns them.
 *
 * Returns `input` untouched when there is nothing to strip, so the common path
 * allocates nothing.
 *
 * @internal Exported for unit tests.
 */
export function withoutToolExecutors<Input extends TaskInput>(input: Input): Input {
  const tools = (input as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return input;
  let stripped = false;
  const plain = tools.map((tool) => {
    if (
      tool !== null &&
      typeof tool === "object" &&
      typeof (tool as { execute?: unknown }).execute === "function"
    ) {
      stripped = true;
      const { execute: _execute, ...rest } = tool as Record<string, unknown>;
      return rest;
    }
    return tool;
  });
  return stripped ? ({ ...input, tools: plain } as Input) : input;
}

export class AiTask<
  Input extends AiTaskInput = AiTaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends TaskConfig<Input> = TaskConfig<Input>,
> extends Task<Input, Output, Config> {
  public static override type: string = "AiTask";
  public static override hasDynamicEntitlements: boolean = true;

  /**
   * Capabilities this task requires from the model selected at execution time.
   * A model that declares capabilities must include every required one, or
   * dispatch throws. A model that declares NO capabilities passes (treated as
   * unverified-allow), so inline ModelConfigs without a capabilities list still
   * run — matching {@link validateInput} / {@link narrowInput}. An empty
   * `requires` passes vacuously (pure-compute subclasses that don't dispatch).
   */
  public static readonly requires: readonly Capability[] = [];

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.AI_INFERENCE, reason: "Runs AI model inference" }],
    };
  }

  public override entitlements(): TaskEntitlements {
    const base: TaskEntitlement[] = [
      { id: Entitlements.AI_INFERENCE, reason: "Runs AI model inference" },
    ];
    // Prefer runInputData.model (runtime) over defaults.model (construction-time).
    const runModel = this.runInputData?.model;
    const modelId =
      typeof runModel === "string"
        ? runModel
        : typeof this.defaults.model === "string"
          ? this.defaults.model
          : undefined;
    if (modelId) {
      base.push({
        id: Entitlements.AI_MODEL,
        reason: `Uses model ${modelId}`,
        resources: [modelId],
      });
    }
    return { entitlements: base };
  }

  public static override configSchema(): DataPortSchema {
    return aiTaskConfigSchema;
  }

  /**
   * Throws TaskConfigurationError when the model declares capabilities that omit
   * one required by the task class's static `requires`. A model that declares no
   * capabilities passes (see {@link requires}). Both execute() and
   * executeStream() must call this before dispatch — gating is task-side, not
   * strategy-side. Shares {@link modelMeetsRequires} with validateInput /
   * narrowInput so all three gates apply one policy.
   */
  protected gateOrThrow(model: ModelConfig): void {
    const taskClass = this.constructor as typeof AiTask;
    const requires = taskClass.requires;
    if (modelMeetsRequires(model, requires)) return;
    const modelCaps = (model.capabilities as readonly Capability[] | undefined) ?? [];
    const missing = requires.filter((r) => !modelCaps.includes(r));
    throw new TaskConfigurationError(
      `Model "${model.model_id ?? "(inline config)"}" is missing capabilities required by ` +
        `${taskClass.type}: ${missing.join(", ")}.`
    );
  }

  override async execute(
    input: Input,
    executeContext: IExecuteContext
  ): Promise<Output | undefined> {
    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") {
      throw new TaskConfigurationError(
        "AiTask: Model was not resolved to ModelConfig - this indicates a bug in the resolution system"
      );
    }

    this.gateOrThrow(model);

    const jobInput = await this.getJobInput(input);
    const strategy = getAiProviderRegistry().getStrategy(model);

    const { emit: observeEvent, result } = accumulatingEmit<Output>();
    const progressUpdates: Promise<void>[] = [];
    let progressError: unknown;
    const emit: AiEmit<Output> = (event) => {
      if (event.type === "phase") {
        progressUpdates.push(
          executeContext.updateProgress(event.progress, event.message).catch((err: unknown) => {
            progressError ??= err;
          })
        );
      }
      observeEvent(event);
    };
    let providerError: unknown;
    try {
      await strategy.execute(jobInput, executeContext, this.runConfig.runnerId, emit as AiEmit);
    } catch (e) {
      providerError = e;
    }
    if (progressUpdates.length > 0) {
      await Promise.all(progressUpdates);
      if (progressError !== undefined && providerError === undefined) {
        throw progressError;
      }
    }
    let output: Output | undefined;
    try {
      output = result();
    } catch (e) {
      // Materialisation failed (most commonly: stream ended without a `finish`
      // event). If the provider already failed, prefer the original cause —
      // the missing-finish symptom is just a downstream consequence. Wrap in
      // a `TaskError` and propagate any discriminating `code` set by the
      // accumulator (e.g. `ACCUMULATOR_NO_FINISH`).
      const cause = providerError ?? e;
      const matErr = e as { code?: string; message?: string; lastEventType?: string };
      const providerMsg =
        providerError instanceof Error
          ? providerError.message
          : providerError !== undefined
            ? asText(providerError)
            : undefined;
      const wrapped = new TaskError(
        providerError !== undefined
          ? `AiTask: provider failed before stream completion (${providerMsg})`
          : (matErr?.message ?? String(e))
      ) as TaskError & { cause?: unknown; code?: string; lastEventType?: string };
      wrapped.cause = cause;
      if (providerError === undefined && matErr?.code) {
        wrapped.code = matErr.code;
        if (matErr.lastEventType !== undefined) {
          wrapped.lastEventType = matErr.lastEventType;
        }
      }
      throw wrapped;
    }
    if (providerError !== undefined) {
      // Provider rejected after producing a usable accumulation (rare): still
      // surface the original provider error to the caller so error-shape
      // expectations are stable.
      throw providerError;
    }

    recordUsageTelemetry(output, this.type, model.model_id);

    // collectStream has already returned the final value, so this is the one
    // and only usage publication for the non-streaming path.
    const finalUsage = readUsage(output);
    if (finalUsage) {
      this.runUsage = finalUsage;
      this.runUsageModelId = model.model_id;
      try {
        this.emit("usage", finalUsage, model.model_id);
      } catch (err) {
        getLogger().error("usage listener threw", { taskId: this.id, error: err });
      }
    }

    // Register a disposer so the caller can release the in-memory model when
    // done. The disposer is wired via the "model.dispose" capability —
    // distinct from "model.download-remove" (which deletes the on-disk
    // copy). Providers opt in by registering a run-fn whose `serves` set
    // contains "model.dispose"; bypasses the task's own `requires` so we
    // don't gate the lifecycle hook on the task.
    if (executeContext.resourceScope) {
      const registry = getAiProviderRegistry();
      const disposeFn = registry.getRunFnFor(model.provider, ["model.dispose"]);
      if (disposeFn) {
        const modelPath =
          (model as ModelConfig & { model?: string }).model ??
          (model.provider_config as Record<string, unknown> | undefined)?.["model_path"] ??
          model.model_id;
        const resourceKey = `ai:${model.provider}:${asText(modelPath)}`;
        executeContext.resourceScope.register(resourceKey, async () => {
          await disposeFn({ model } as TaskInput, model, AbortSignal.timeout(30_000), noopEmit);
        });
        executeContext.resourceScope.touch(resourceKey);
      }
    }

    return output;
  }

  /**
   * Get the input to submit to the job queue (or direct execution).
   * Transforms the task input to AiJobInput format.
   */
  protected async getJobInput(input: Input): Promise<AiJobInput<Input>> {
    const model = input.model as ModelConfig;

    const runtype = (this.constructor as any).runtype ?? (this.constructor as any).type;
    const taskClass = this.constructor as typeof AiTask;

    const jobInput: AiJobInput<Input> = {
      taskType: runtype,
      requires: taskClass.requires,
      aiProvider: model.provider,
      taskInput: withoutToolExecutors(input) as Input & { model: ModelConfig },
    };

    const taskTimeoutMs = (this.config as TaskConfig).timeout;
    if (typeof taskTimeoutMs === "number" && taskTimeoutMs > 0) {
      jobInput.timeoutMs = taskTimeoutMs;
    }

    const inputOutputSchema = input.outputSchema as DataPortSchema;
    if (
      inputOutputSchema &&
      typeof inputOutputSchema === "object" &&
      !Array.isArray(inputOutputSchema) &&
      typeof inputOutputSchema.type === "string"
    ) {
      jobInput.outputSchema = inputOutputSchema;
    } else {
      const taskOutputSchema = this.outputSchema();
      if (hasStructuredOutput(taskOutputSchema)) {
        jobInput.outputSchema = taskOutputSchema;
      }
    }

    const sessionId = (input as any).sessionId as string | undefined;
    if (sessionId) {
      jobInput.session = { sessionId };
    }

    return jobInput;
  }

  /**
   * Creates a new Job instance for direct execution (without a queue).
   */
  async createJob(input: Input, queueName?: string): Promise<AiJob<AiJobInput<Input>, Output>> {
    const jobInput = await this.getJobInput(input);
    const resolvedQueueName = queueName ?? (await this.getDefaultQueueName(input));
    if (!resolvedQueueName) {
      throw new TaskConfigurationError("AiTask: Unable to determine queue for AI provider");
    }
    const job = new AiJob<AiJobInput<Input>, Output>({
      queueName: resolvedQueueName,
      jobRunId: this.runConfig.runnerId,
      input: jobInput,
    });
    return job;
  }

  /**
   * Gets the default queue name based on the model's provider.
   */
  protected async getDefaultQueueName(input: Input): Promise<string | undefined> {
    const model = input.model as ModelConfig;
    return model?.provider;
  }

  /**
   * Delegates to a provider-registered preview run function if one exists,
   * otherwise falls back to the default Task.executePreview().
   */
  override async executePreview(
    input: Input,
    context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    const model = input.model as ModelConfig | undefined;
    if (model && typeof model === "object" && model.provider) {
      const taskType = (this.constructor as any).runtype ?? (this.constructor as any).type;
      const previewFn = getAiProviderRegistry().getPreviewRunFn<Input, Output>(
        model.provider,
        taskType
      );
      if (previewFn) {
        return previewFn(input, model);
      }
    }
    return super.executePreview(input, context);
  }

  /**
   * Validates that model inputs are valid ModelConfig objects.
   */
  public override async validateInput(
    input: Input,
    skipPorts?: ReadonlySet<string>
  ): Promise<boolean> {
    const inputSchema = this.inputSchema();
    if (typeof inputSchema === "boolean") {
      if (inputSchema === false) {
        throw new TaskConfigurationError(`AiTask: Input schema is 'false' and accepts no inputs`);
      }
      return true;
    }

    const modelTaskProperties = Object.entries<JsonSchema>(
      (inputSchema.properties || {}) as Record<string, JsonSchema>
    ).filter(([, schema]) => modelSemanticFromPropertySchema(schema)?.startsWith("model:"));

    const hostTaskClass = this.constructor as typeof AiTask;

    for (const [key, propertySchema] of modelTaskProperties) {
      const model = input[key];
      if (typeof model === "object" && model !== null) {
        const requires = requiresForModelProperty(propertySchema, hostTaskClass);
        const capabilities = (model as ModelConfig).capabilities as string[] | undefined;
        if (!modelMeetsRequires(model as ModelConfig, requires)) {
          const modelId = (model as ModelConfig).model_id ?? "(inline config)";
          const semantic = modelSemanticFromPropertySchema(propertySchema);
          const referencedTaskType =
            semantic?.startsWith("model:") === true ? semantic.slice("model:".length) : this.type;
          throw new TaskConfigurationError(
            `AiTask: Model "${modelId}" for '${key}' is not compatible with task '${referencedTaskType}'. ` +
              `Requires: [${requires.join(", ")}]; model has: [${capabilities?.join(", ") ?? ""}]`
          );
        }
      } else if (model !== undefined && model !== null) {
        throw new TaskConfigurationError(
          `AiTask: Invalid model for '${key}' - expected ModelConfig object but got ${typeof model}. ` +
            `Ensure the model ID was registered in the ModelRepository before running the task.`
        );
      }
    }

    const modelPlainProperties = Object.entries<JsonSchema>(
      (inputSchema.properties || {}) as Record<string, JsonSchema>
    ).filter(([key, schema]) => schemaFormat(schema) === "model");

    for (const [key] of modelPlainProperties) {
      const model = input[key];
      if (model !== undefined && model !== null && typeof model !== "object") {
        throw new TaskConfigurationError(
          `AiTask: Invalid model for '${key}' - expected ModelConfig object but got ${typeof model}. ` +
            `Ensure the model ID was registered in the ModelRepository before running the task.`
        );
      }
    }

    return super.validateInput(input, skipPorts);
  }

  public override async narrowInput(input: Input, registry: ServiceRegistry): Promise<Input> {
    const inputSchema = this.inputSchema();
    if (typeof inputSchema === "boolean") {
      if (inputSchema === false) {
        throw new TaskConfigurationError(`AiTask: Input schema is 'false' and accepts no inputs`);
      }
      return input;
    }
    const narrowed = { ...input };
    const modelTaskProperties = Object.entries<JsonSchema>(
      (inputSchema.properties || {}) as Record<string, JsonSchema>
    ).filter(([, schema]) => modelSemanticFromPropertySchema(schema)?.startsWith("model:"));
    if (modelTaskProperties.length > 0) {
      const modelRepo = getGlobalModelRepository(registry);
      const hostTaskClass = this.constructor as typeof AiTask;

      for (const [key, propertySchema] of modelTaskProperties) {
        const requestedModel = input[key];
        const requires = requiresForModelProperty(propertySchema, hostTaskClass);

        if (typeof requestedModel === "string") {
          const found = await modelRepo.findByName(requestedModel);
          if (!found || !modelMeetsRequires(found, requires)) {
            (narrowed as any)[key] = undefined;
          }
        } else if (typeof requestedModel === "object" && requestedModel !== null) {
          if (!modelMeetsRequires(requestedModel as ModelConfig, requires)) {
            (narrowed as any)[key] = undefined;
          }
        }
      }
    }
    return narrowed;
  }
}
