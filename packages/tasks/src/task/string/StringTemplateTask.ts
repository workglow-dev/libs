/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

/**
 * One pass over the template. Replacing key by key re-scanned what earlier keys had
 * substituted, so a value such as "{{secret}}" expanded into another key's value --
 * or did not, depending on key order. A placeholder with no value stays as written.
 */
function renderStringTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder
  );
}

const inputSchema = {
  type: "object",
  properties: {
    template: {
      type: "string",
      title: "Template",
      description: "Template string with {{key}} placeholders",
    },
    values: {
      type: "object",
      title: "Values",
      description: "Key-value pairs to substitute into the template",
      additionalProperties: true,
    },
  },
  required: ["template", "values"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Template with placeholders replaced by values",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type StringTemplateTaskInput = FromSchema<typeof inputSchema>;
export type StringTemplateTaskOutput = FromSchema<typeof outputSchema>;

/**
 * @deprecated Use {@link TemplateTask} instead, which supports dot-notation paths
 * and `{{key|default}}` fallback syntax.
 */
export class StringTemplateTask<
  Input extends StringTemplateTaskInput = StringTemplateTaskInput,
  Output extends StringTemplateTaskOutput = StringTemplateTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "StringTemplateTask";
  static override readonly category = "String";
  public static override title = "Template";
  public static override description =
    "Replaces {{key}} placeholders in a template string with values";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context: IExecuteContext): Promise<Output | undefined> {
    return { text: renderStringTemplate(input.template, input.values) } as Output;
  }

  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return { text: renderStringTemplate(input.template, input.values) } as Output;
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    stringTemplate: CreateWorkflow<StringTemplateTaskInput, StringTemplateTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.stringTemplate = CreateWorkflow(StringTemplateTask);
