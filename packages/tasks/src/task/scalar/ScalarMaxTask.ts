/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    values: {
      type: "array",
      items: { type: "number" },
      title: "Values",
      description: "Array of numbers",
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
      description: "Maximum value",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarMaxTaskInput = FromSchema<typeof inputSchema>;
export type ScalarMaxTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarMaxTask<
  Input extends ScalarMaxTaskInput = ScalarMaxTaskInput,
  Output extends ScalarMaxTaskOutput = ScalarMaxTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarMaxTask";
  static override readonly category = "Math";
  public static override title = "Max";
  public static override description = "Returns the largest of the given numbers";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    // Folded rather than spread: `Math.max(...values)` passes every element as an
    // argument, and engines cap argument counts — a million values threw a RangeError.
    // Folding with Math.max itself keeps its NaN and signed-zero rules.
    let result = -Infinity;
    for (const value of input.values) result = Math.max(result, value);
    return { result } as Output;
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
    scalarMax: CreateWorkflow<ScalarMaxTaskInput, ScalarMaxTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarMax = CreateWorkflow(ScalarMaxTask);
