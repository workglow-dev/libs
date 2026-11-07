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
      description: "Sum of a and b",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarAddTaskInput = FromSchema<typeof inputSchema>;
export type ScalarAddTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarAddTask<
  Input extends ScalarAddTaskInput = ScalarAddTaskInput,
  Output extends ScalarAddTaskOutput = ScalarAddTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarAddTask";
  static override readonly category = "Math";
  public static override title = "Add";
  public static override description = "Returns the sum of two numbers";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: sumPrecise([input.a, input.b]) } as Output;
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
    scalarAdd: CreateWorkflow<ScalarAddTaskInput, ScalarAddTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarAdd = CreateWorkflow(ScalarAddTask);
