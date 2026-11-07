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
    value: {
      type: "number",
      title: "Value",
      description: "Input number",
    },
  },
  required: ["value"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      title: "Result",
      description: "Ceiling value",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarCeilTaskInput = FromSchema<typeof inputSchema>;
export type ScalarCeilTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarCeilTask<
  Input extends ScalarCeilTaskInput = ScalarCeilTaskInput,
  Output extends ScalarCeilTaskOutput = ScalarCeilTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarCeilTask";
  static override readonly category = "Math";
  public static override title = "Ceil";
  public static override description =
    "Returns the smallest integer greater than or equal to a number";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: Math.ceil(input.value) } as Output;
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
    scalarCeil: CreateWorkflow<ScalarCeilTaskInput, ScalarCeilTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarCeil = CreateWorkflow(ScalarCeilTask);
