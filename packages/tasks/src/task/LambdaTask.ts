/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  IExecutePreviewContext,
  IRunConfig,
  TaskConfig,
  TaskInput,
  TaskOutput,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  DATAFLOW_ALL_PORTS,
  Task,
  TaskConfigSchema,
  TaskConfigurationError,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";

export const lambdaTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    execute: {},
    executePreview: {},
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

type LambdaTaskConfig<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
> = TaskConfig & {
  execute?: (input: Input, context: IExecuteContext) => Promise<Output>;
  executePreview?: (input: Input, context: IExecutePreviewContext) => Promise<Output | undefined>;
};

const inputSchema = {
  type: "object",
  properties: {
    [DATAFLOW_ALL_PORTS]: {
      title: "Input",
      description: "Input data to pass to the function",
    },
  },
  additionalProperties: true,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    [DATAFLOW_ALL_PORTS]: {
      title: "Output",
      description: "The output from the execute function",
    },
  },
  additionalProperties: true,
} as const satisfies DataPortSchema;

export type LambdaTaskInput = Record<string, any>;
export type LambdaTaskOutput = Record<string, any>;
export class LambdaTask<
  Input extends TaskInput = LambdaTaskInput,
  Output extends TaskOutput = LambdaTaskOutput,
  Config extends LambdaTaskConfig<Input, Output> = LambdaTaskConfig<Input, Output>,
> extends Task<Input, Output, Config> {
  public static override type = "LambdaTask";
  public static override title = "Lambda Task";
  public static override description = "A task that wraps a provided function and its input";
  public static override category = "Hidden";
  /**
   * Never cached. The output cache keys on task type and input, and the function a
   * lambda runs is not part of that key, so two lambdas sharing a cache would answer
   * for each other. `QuickTask` (a function passed to `pipe()`) is uncached for the
   * same reason.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override configSchema(): DataPortSchema {
    return lambdaTaskConfigSchema;
  }
  public static override inputSchema() {
    return inputSchema;
  }
  public static override outputSchema() {
    return outputSchema;
  }

  public override canSerializeConfig(): boolean {
    return false;
  }

  constructor(config: Partial<Config> = {}, runConfig: Partial<IRunConfig> = {}) {
    if (!config.execute && !config.executePreview) {
      throw new TaskConfigurationError(
        "LambdaTask must have either execute or executePreview function in config"
      );
    }
    super(config, runConfig);
  }

  override async execute(input: Input, context: IExecuteContext): Promise<Output> {
    if (typeof this.config.execute === "function") {
      return await this.config.execute(input, context);
    }
    return {} as Output;
  }

  override async executePreview(
    input: Input,
    context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    if (typeof this.config.executePreview === "function") {
      return await this.config.executePreview(input, context);
    }
    return undefined;
  }
}

export function lambda<I extends TaskInput, O extends TaskOutput>(
  fn: (input: I, context: IExecuteContext) => Promise<O>
): Promise<TaskOutput>;
export function lambda<I extends TaskInput, O extends TaskOutput>(
  input: I,
  config?: LambdaTaskConfig<I, O>
): Promise<TaskOutput>;

export function lambda<I extends TaskInput, O extends TaskOutput>(
  input: I | ((input: I, context: IExecuteContext) => Promise<O>),
  config?: LambdaTaskConfig<I, O>
): Promise<TaskOutput> {
  if (typeof input === "function") {
    const task = new LambdaTask<I, O>({
      execute: input,
    } as any);
    return task.run();
  }
  const task = new LambdaTask<I, O>({ ...config, defaults: input as Partial<I> } as any);
  return task.run();
}

declare module "@workglow/task-graph" {
  interface Workflow {
    lambda: CreateWorkflow<
      LambdaTaskInput,
      LambdaTaskOutput,
      LambdaTaskConfig<LambdaTaskInput, LambdaTaskOutput>
    >;
  }
}

Workflow.prototype.lambda = CreateWorkflow(LambdaTask);
