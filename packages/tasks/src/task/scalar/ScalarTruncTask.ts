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
      description: "Truncated value",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ScalarTruncTaskInput = FromSchema<typeof inputSchema>;
export type ScalarTruncTaskOutput = FromSchema<typeof outputSchema>;

export class ScalarTruncTask<
  Input extends ScalarTruncTaskInput = ScalarTruncTaskInput,
  Output extends ScalarTruncTaskOutput = ScalarTruncTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "ScalarTruncTask";
  static override readonly category = "Math";
  public static override title = "Truncate";
  public static override description =
    "Returns the integer part of a number by removing fractional digits";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context?: IExecuteContext): Promise<Output> {
    return { result: Math.trunc(input.value) } as Output;
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
    scalarTrunc: CreateWorkflow<ScalarTruncTaskInput, ScalarTruncTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.scalarTrunc = CreateWorkflow(ScalarTruncTask);
