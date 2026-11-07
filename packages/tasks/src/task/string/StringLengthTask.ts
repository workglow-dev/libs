/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskConfigSchema, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

const LENGTH_UNITS = ["code-units", "code-points", "graphemes"] as const;
export type StringLengthUnit = (typeof LENGTH_UNITS)[number];

let graphemeSegmenter: Intl.Segmenter | undefined;

function stringLength(text: string, unit: StringLengthUnit | undefined): number {
  switch (unit) {
    case "code-points": {
      let count = 0;
      for (const _ of text) count++;
      return count;
    }
    case "graphemes": {
      graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let count = 0;
      for (const _ of graphemeSegmenter.segment(text)) count++;
      return count;
    }
    default:
      return text.length;
  }
}

const configSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    unit: {
      type: "string",
      enum: LENGTH_UNITS,
      default: "code-units",
      title: "Unit",
      description:
        "What to count: UTF-16 code units (JavaScript's length), Unicode code points, or user-perceived characters (graphemes)",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type StringLengthTaskConfig = TaskConfig & { readonly unit?: StringLengthUnit | undefined };

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Input string",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    length: {
      type: "integer",
      title: "Length",
      description: "Length of the string",
    },
  },
  required: ["length"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type StringLengthTaskInput = FromSchema<typeof inputSchema>;
export type StringLengthTaskOutput = FromSchema<typeof outputSchema>;

export class StringLengthTask<
  Input extends StringLengthTaskInput = StringLengthTaskInput,
  Output extends StringLengthTaskOutput = StringLengthTaskOutput,
  Config extends StringLengthTaskConfig = StringLengthTaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "StringLengthTask";
  static override readonly category = "String";
  public static override title = "Length";
  public static override description = "Returns the length of a string";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  static override configSchema(): DataPortSchema {
    return configSchema;
  }

  override async execute(input: Input, _context: IExecuteContext): Promise<Output | undefined> {
    return { length: stringLength(input.text, this.config?.unit) } as Output;
  }

  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return { length: stringLength(input.text, this.config?.unit) } as Output;
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    stringLength: CreateWorkflow<
      StringLengthTaskInput,
      StringLengthTaskOutput,
      StringLengthTaskConfig
    >;
  }
}

Workflow.prototype.stringLength = CreateWorkflow(StringLengthTask);
