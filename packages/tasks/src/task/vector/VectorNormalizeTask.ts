/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema, TypedArraySchemaOptions } from "@workglow/util/schema";
import { TypedArraySchema, normalize } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    vector: TypedArraySchema({
      title: "Vector",
      description: "Input vector to normalize",
    }),
  },
  required: ["vector"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: TypedArraySchema({
      title: "Result",
      description: "L2-normalized vector",
    }),
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorNormalizeTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorNormalizeTaskOutput = FromSchema<typeof outputSchema, TypedArraySchemaOptions>;

export class VectorNormalizeTask<
  Input extends VectorNormalizeTaskInput = VectorNormalizeTaskInput,
  Output extends VectorNormalizeTaskOutput = VectorNormalizeTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorNormalizeTask";
  static override readonly category = "Vector";
  public static override title = "Normalize";
  public static override description = "Returns the L2-normalized (unit length) vector";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: normalize(input.vector) } as Output;
  }

  /** Pure and instant, so a preview shows the value a run would produce. */
  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return this.execute(input);
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    vectorNormalize: CreateWorkflow<
      VectorNormalizeTaskInput,
      VectorNormalizeTaskOutput,
      TaskConfig
    >;
  }
}

Workflow.prototype.vectorNormalize = CreateWorkflow(VectorNormalizeTask);
