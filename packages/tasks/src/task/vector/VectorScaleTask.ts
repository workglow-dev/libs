/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema, TypedArraySchemaOptions } from "@workglow/util/schema";
import { createTypedArrayFrom, TypedArraySchema } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    vector: TypedArraySchema({
      title: "Vector",
      description: "Input vector",
    }),
    scalar: {
      type: "number",
      title: "Scalar",
      description: "Scalar multiplier",
    },
  },
  required: ["vector", "scalar"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: TypedArraySchema({
      title: "Result",
      description: "Scaled vector",
    }),
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorScaleTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorScaleTaskOutput = FromSchema<typeof outputSchema, TypedArraySchemaOptions>;

export class VectorScaleTask<
  Input extends VectorScaleTaskInput = VectorScaleTaskInput,
  Output extends VectorScaleTaskOutput = VectorScaleTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorScaleTask";
  static override readonly category = "Vector";
  public static override title = "Scale";
  public static override description = "Multiplies each element of a vector by a scalar";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    const { vector, scalar } = input;
    const values = Array.from(vector, (v) => Number(v) * scalar);
    return { result: createTypedArrayFrom([vector], values) } as Output;
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
    vectorScale: CreateWorkflow<VectorScaleTaskInput, VectorScaleTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.vectorScale = CreateWorkflow(VectorScaleTask);
