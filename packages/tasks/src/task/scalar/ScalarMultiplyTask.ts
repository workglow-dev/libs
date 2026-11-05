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
    a: {
      type: "number",
      title: "A",
      description: "First number",
    },
    b: {
      type: "number",
      title: "B",
      description: "Second number",
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
      description: "Product of a and b",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarMultiplyTaskInput = FromSchema<typeof inputSchema>;
export type ScalarMultiplyTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarMultiplyTask<
  Input extends ScalarMultiplyTaskInput = ScalarMultiplyTaskInput,
  Output extends ScalarMultiplyTaskOutput = ScalarMultiplyTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarMultiplyTask";
  static override readonly category = "Math";
  public static override title = "Multiply";
  public static override description = "Returns the product of two numbers";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: input.a * input.b } as Output;
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
    scalarMultiply: CreateWorkflow<ScalarMultiplyTaskInput, ScalarMultiplyTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarMultiply = CreateWorkflow(ScalarMultiplyTask);
