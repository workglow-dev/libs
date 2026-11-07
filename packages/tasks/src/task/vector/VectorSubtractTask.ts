/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskInvalidInputError, Workflow } from "@workglow/task-graph";
import type {
  DataPortSchema,
  FromSchema,
  TypedArray,
  TypedArraySchemaOptions,
} from "@workglow/util/schema";
import { createTypedArrayFrom, TypedArraySchema } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    vectors: {
      type: "array",
      items: TypedArraySchema({
        title: "Vector",
        description: "Vector (first is minuend, rest are subtrahends)",
      }),
      title: "Vectors",
      description: "Array of vectors: vectors[0] - vectors[1] - vectors[2] - ...",
    },
  },
  required: ["vectors"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: TypedArraySchema({
      title: "Result",
      description: "Difference of vectors",
    }),
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorSubtractTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorSubtractTaskOutput = FromSchema<typeof outputSchema, TypedArraySchemaOptions>;

export class VectorSubtractTask<
  Input extends VectorSubtractTaskInput = VectorSubtractTaskInput,
  Output extends VectorSubtractTaskOutput = VectorSubtractTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorSubtractTask";
  static override readonly category = "Vector";
  public static override title = "Subtract";
  public static override description =
    "Returns component-wise difference: vectors[0] - vectors[1] - vectors[2] - ...";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    const { vectors } = input as { vectors: TypedArray[] };
    if (vectors.length < 2) {
      throw new TaskInvalidInputError("At least two vectors are required");
    }
    const len = vectors[0].length;
    for (let i = 1; i < vectors.length; i++) {
      if (vectors[i].length !== len) {
        throw new TaskInvalidInputError("All vectors must have the same length");
      }
    }
    const values = Array.from({ length: len }, (_, i) => {
      let acc = Number(vectors[0][i]);
      for (let j = 1; j < vectors.length; j++) {
        acc -= Number(vectors[j][i]);
      }
      return acc;
    });
    return { result: createTypedArrayFrom(vectors, values) } as Output;
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
    vectorSubtract: CreateWorkflow<VectorSubtractTaskInput, VectorSubtractTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.vectorSubtract = CreateWorkflow(VectorSubtractTask);
