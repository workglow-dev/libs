/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { sumPrecise } from "./sumPrecise";

const inputSchema = {
  type: "object",
  properties: {
    values: {
      type: "array",
      items: { type: "number" },
      title: "Values",
      description: "Array of numbers to sum",
    },
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      title: "Result",
      description: "Sum of all values",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarSumTaskInput = FromSchema<typeof inputSchema>;
export type ScalarSumTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarSumTask<
  Input extends ScalarSumTaskInput = ScalarSumTaskInput,
  Output extends ScalarSumTaskOutput = ScalarSumTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarSumTask";
  static override readonly category = "Math";
  public static override title = "Sum";
  public static override description = "Returns the sum of an array of numbers";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: sumPrecise(input.values) } as Output;
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
    scalarSum: CreateWorkflow<ScalarSumTaskInput, ScalarSumTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarSum = CreateWorkflow(ScalarSumTask);
