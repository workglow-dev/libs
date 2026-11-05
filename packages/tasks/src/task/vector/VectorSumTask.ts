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
import { sumPrecise } from "../scalar/sumPrecise";

const inputSchema = {
  type: "object",
  properties: {
    vectors: {
      type: "array",
      items: TypedArraySchema({
        title: "Vector",
        description: "Vector to sum",
      }),
      title: "Vectors",
      description: "Array of vectors to sum component-wise",
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
      description: "Sum of vectors",
    }),
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorSumTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorSumTaskOutput = FromSchema<typeof outputSchema, TypedArraySchemaOptions>;

export class VectorSumTask<
  Input extends VectorSumTaskInput = VectorSumTaskInput,
  Output extends VectorSumTaskOutput = VectorSumTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorSumTask";
  static override readonly category = "Vector";
  public static override title = "Sum";
  public static override description = "Returns the component-wise sum of an array of vectors";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    const { vectors } = input as { vectors: TypedArray[] };
    if (vectors.length === 0) {
      throw new TaskInvalidInputError("At least one vector is required");
    }
    const len = vectors[0].length;
    for (let i = 1; i < vectors.length; i++) {
      if (vectors[i].length !== len) {
        throw new TaskInvalidInputError("All vectors must have the same length");
      }
    }
    const values = Array.from({ length: len }, (_, i) =>
      sumPrecise(vectors.map((v) => Number(v[i])))
    );
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
    vectorSum: CreateWorkflow<VectorSumTaskInput, VectorSumTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.vectorSum = CreateWorkflow(VectorSumTask);
