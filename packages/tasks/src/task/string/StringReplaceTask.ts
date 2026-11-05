/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

function replaceString(text: string, search: string, replace: string): string {
  // A function replacement is inserted as is; a string one would expand `$&`, `$$`, `$1`.
  return text.replaceAll(search, () => replace);
}

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Input string",
    },
    search: {
      type: "string",
      title: "Search",
      description: "Substring to search for",
    },
    replace: {
      type: "string",
      title: "Replace",
      description: "Replacement string",
    },
  },
  required: ["text", "search", "replace"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "String with all occurrences replaced",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type StringReplaceTaskInput = FromSchema<typeof inputSchema>;
export type StringReplaceTaskOutput = FromSchema<typeof outputSchema>;

export class StringReplaceTask<
  Input extends StringReplaceTaskInput = StringReplaceTaskInput,
  Output extends StringReplaceTaskOutput = StringReplaceTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "StringReplaceTask";
  static override readonly category = "String";
  public static override title = "Replace";
  public static override description = "Replaces all occurrences of a substring";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context: IExecuteContext): Promise<Output | undefined> {
    return { text: replaceString(input.text, input.search, input.replace) } as Output;
  }

  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return { text: replaceString(input.text, input.search, input.replace) } as Output;
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    stringReplace: CreateWorkflow<StringReplaceTaskInput, StringReplaceTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.stringReplace = CreateWorkflow(StringReplaceTask);
