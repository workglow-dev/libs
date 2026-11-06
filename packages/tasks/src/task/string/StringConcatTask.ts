/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

/**
 * Joins the values in the order the ports are declared (what a builder draws), then
 * any undeclared port by name. Arrival order depends on which upstream task finished
 * first, so it could change the answer from one run to the next.
 */
function concatStrings(input: Record<string, unknown>, declared: readonly string[]): string {
  const known = new Set(declared);
  const rest = Object.keys(input)
    .filter((key) => !known.has(key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...declared.filter((key) => key in input), ...rest].map((key) => input[key]).join("");
}

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: { type: "string" },
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Concatenation of all input strings",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type StringConcatTaskInput = FromSchema<typeof inputSchema>;
export type StringConcatTaskOutput = FromSchema<typeof outputSchema>;

export class StringConcatTask<
  Input extends StringConcatTaskInput = StringConcatTaskInput,
  Output extends StringConcatTaskOutput = StringConcatTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "StringConcatTask";
  static override readonly category = "String";
  public static override title = "Concat";
  public static override description =
    "Concatenates all input strings, in the order the ports are declared";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  private declaredPorts(): readonly string[] {
    const properties = (this.config?.inputSchema as { properties?: unknown } | undefined)
      ?.properties;
    return properties && typeof properties === "object" ? Object.keys(properties) : [];
  }

  override async execute(input: Input, _context: IExecuteContext): Promise<Output | undefined> {
    return { text: concatStrings(input, this.declaredPorts()) } as Output;
  }

  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return { text: concatStrings(input, this.declaredPorts()) } as Output;
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    stringConcat: CreateWorkflow<StringConcatTaskInput, StringConcatTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.stringConcat = CreateWorkflow(StringConcatTask);
