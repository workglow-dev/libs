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
import { TypedArraySchema } from "@workglow/util/schema";
import { sumPrecise } from "../scalar/sumPrecise";

const inputSchema = {
  type: "object",
  properties: {
    vectors: {
      type: "array",
      items: TypedArraySchema({
        title: "Vector",
        description: "Vector for dot product",
      }),
      title: "Vectors",
      description: "Array of two vectors to compute dot product",
    },
  },
  required: ["vectors"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      title: "Result",
      description: "Dot product of the vectors",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorDotProductTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorDotProductTaskOutput = FromSchema<typeof outputSchema>;

export class VectorDotProductTask<
  Input extends VectorDotProductTaskInput = VectorDotProductTaskInput,
  Output extends VectorDotProductTaskOutput = VectorDotProductTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorDotProductTask";
  static override readonly category = "Vector";
  public static override title = "Dot Product";
  public static override description = "Returns the dot (inner) product of the first two vectors";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    const { vectors } = input as { vectors: TypedArray[] };
    if (vectors.length < 2) {
      throw new TaskInvalidInputError("Exactly two vectors are required for dot product");
    }
    const [a, b] = vectors;
    if (a.length !== b.length) {
      throw new TaskInvalidInputError("Vectors must have the same length");
    }
    const products = Array.from({ length: a.length }, (_, i) => Number(a[i]) * Number(b[i]));
    return { result: sumPrecise(products) } as Output;
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
    vectorDotProduct: CreateWorkflow<
      VectorDotProductTaskInput,
      VectorDotProductTaskOutput,
      TaskConfig
    >;
  }
}

Workflow.prototype.vectorDotProduct = CreateWorkflow(VectorDotProductTask);
