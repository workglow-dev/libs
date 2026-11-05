/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskConfigSchema, TaskInvalidInputError } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserFillTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    clearFirst: {
      type: "boolean",
      title: "Clear First",
      description: "Whether to clear the field before filling",
      default: true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserFillTaskConfig = TaskConfig & {
  clearFirst?: boolean;
};

const inputSchema = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "The browser session to use",
    },
    ref: {
      type: "string",
      title: "Element Ref",
      description: "The element reference to fill",
    },
    label: {
      type: "string",
      title: "Label",
      description: "The label text of the input to fill",
    },
    value: {
      type: "string",
      title: "Value",
      description: "The value to fill into the input",
    },
  },
  required: ["sessionId", "value"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "The browser session ID",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserFillTaskInput = FromSchema<typeof inputSchema>;
export type BrowserFillTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserFillTask extends Task<
  BrowserFillTaskInput,
  BrowserFillTaskOutput,
  BrowserFillTaskConfig
> {
  static override readonly type = "BrowserFillTask";
  static override readonly category = "Browser";
  public static override title = "Browser Fill";
  public static override description = "Fills a text input in the browser by ref or by label";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserFillTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserFillTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserFillTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    if (input.ref) {
      await ctx.fill(input.ref, input.value);
    } else if (input.label) {
      await ctx.fillByLabel(input.label, input.value);
    } else {
      throw new TaskInvalidInputError("BrowserFillTask: either ref or label must be provided");
    }
    return { sessionId: input.sessionId };
  }
}
