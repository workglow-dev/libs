/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskInvalidInputError, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    a: {
      type: "number",
      title: "A",
      description: "Numerator",
    },
    b: {
      type: "number",
      title: "B",
      description: "Denominator",
    },
  },
  required: ["a", "b"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      title: "Result",
      description: "Quotient (a / b)",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarDivideTaskInput = FromSchema<typeof inputSchema>;
export type ScalarDivideTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarDivideTask<
  Input extends ScalarDivideTaskInput = ScalarDivideTaskInput,
  Output extends ScalarDivideTaskOutput = ScalarDivideTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarDivideTask";
  static override readonly category = "Math";
  public static override title = "Divide";
  public static override description = "Returns the quotient of two numbers (a / b)";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    if (input.b === 0) {
      throw new TaskInvalidInputError("Division by zero: denominator (b) cannot be zero");
    }
    return { result: input.a / input.b } as Output;
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
    scalarDivide: CreateWorkflow<ScalarDivideTaskInput, ScalarDivideTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarDivide = CreateWorkflow(ScalarDivideTask);
