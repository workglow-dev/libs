/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskInvalidInputError, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

function formatDate(input: {
  value: string;
  format?: string;
  locale?: string;
  timeZone?: string;
}): string {
  const dateInput = /^\d+$/.test(input.value) ? Number(input.value) : input.value;
  const date = new Date(dateInput);

  if (isNaN(date.getTime())) {
    throw new TaskInvalidInputError(`Invalid date: ${input.value}`);
  }

  const format = input.format ?? "iso";
  const locale = input.locale;
  const timeZone = input.timeZone;

  try {
    return formatAs(date, format, locale, timeZone);
  } catch (error) {
    // Intl rejects an unknown locale tag or IANA zone with a RangeError; both are input.
    if (error instanceof RangeError) {
      // Node's message for a bad locale does not name it, so say what was passed.
      throw new TaskInvalidInputError(
        `Cannot format date with locale ${JSON.stringify(locale ?? null)} and time zone ` +
          `${JSON.stringify(timeZone ?? null)}: ${error.message}`
      );
    }
    throw error;
  }
}

function formatAs(
  date: Date,
  format: string,
  locale: string | undefined,
  timeZone: string | undefined
): string {
  switch (format) {
    case "iso":
      return date.toISOString();
    case "date":
      return date.toLocaleDateString(locale, timeZone ? { timeZone } : undefined);
    case "time":
      return date.toLocaleTimeString(locale, timeZone ? { timeZone } : undefined);
    case "unix":
      return String(date.getTime());
    case "datetime":
    default:
      return date.toLocaleString(locale, timeZone ? { timeZone } : undefined);
  }
}

const inputSchema = {
  type: "object",
  properties: {
    value: {
      type: "string",
      title: "Value",
      description: "Date string, ISO 8601 timestamp, or Unix timestamp in milliseconds",
    },
    format: {
      type: "string",
      title: "Format",
      enum: ["iso", "date", "time", "datetime", "unix"],
      description: "Output format: 'iso', 'date', 'time', 'datetime', 'unix'",
      default: "iso",
    },
    locale: {
      type: "string",
      title: "Locale",
      description: "Locale string (e.g. 'en-US')",
      default: "en-US",
    },
    timeZone: {
      type: "string",
      title: "Time Zone",
      description: "IANA time zone (e.g. 'America/New_York', 'UTC')",
    },
  },
  required: ["value"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: "string",
      title: "Result",
      description: "Formatted date string",
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type DateFormatTaskInput = FromSchema<typeof inputSchema>;
export type DateFormatTaskOutput = FromSchema<typeof outputSchema>;

export class DateFormatTask<
  Input extends DateFormatTaskInput = DateFormatTaskInput,
  Output extends DateFormatTaskOutput = DateFormatTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  static override readonly type = "DateFormatTask";
  static override readonly category = "Utility";
  public static override title = "Date Format";
  public static override description = "Parses and formats a date string";

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, _context: IExecuteContext): Promise<Output | undefined> {
    return { result: formatDate(input) } as Output;
  }

  override async executePreview(
    input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return { result: formatDate(input) } as Output;
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    dateFormat: CreateWorkflow<DateFormatTaskInput, DateFormatTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.dateFormat = CreateWorkflow(DateFormatTask);
