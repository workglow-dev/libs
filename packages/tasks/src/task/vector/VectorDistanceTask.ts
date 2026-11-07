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
        description: "Vector for distance computation",
      }),
      minItems: 2,
      maxItems: 2,
      title: "Vectors",
      description: "The two vectors to compute the Euclidean distance between",
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
      description: "Euclidean distance between vectors",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorDistanceTaskInput = FromSchema<typeof inputSchema, TypedArraySchemaOptions>;
export type VectorDistanceTaskOutput = FromSchema<typeof outputSchema>;

export class VectorDistanceTask<
  Input extends VectorDistanceTaskInput = VectorDistanceTaskInput,
  Output extends VectorDistanceTaskOutput = VectorDistanceTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "VectorDistanceTask";
  static override readonly category = "Vector";
  public static override title = "Distance";
  public static override description = "Returns the Euclidean distance between two vectors";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    const { vectors } = input as { vectors: TypedArray[] };
    if (vectors.length !== 2) {
      throw new TaskInvalidInputError("Exactly two vectors are required for distance");
    }
    const [a, b] = vectors;
    if (a.length !== b.length) {
      throw new TaskInvalidInputError("Vectors must have the same length");
    }
    const diffs = Array.from({ length: a.length }, (_, i) => {
      const d = Number(a[i]) - Number(b[i]);
      return d * d;
    });
    return { result: Math.sqrt(sumPrecise(diffs)) } as Output;
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
    vectorDistance: CreateWorkflow<VectorDistanceTaskInput, VectorDistanceTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.vectorDistance = CreateWorkflow(VectorDistanceTask);
