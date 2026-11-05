/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskConfigSchema, TaskConfigurationError } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserExtractHtmlTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    ref: {
      type: "string",
      title: "Element Ref",
      description: "The element reference to extract HTML from",
    },
    selector: {
      type: "string",
      title: "CSS Selector",
      description: "CSS selector to find element when no ref is provided",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserExtractHtmlTaskConfig = TaskConfig & {
  ref?: string;
  selector?: string;
};

const inputSchema = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "The browser session to use",
    },
  },
  required: ["sessionId"],
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
    html: {
      type: "string",
      title: "HTML",
      description: "The extracted HTML content",
    },
  },
  required: ["sessionId", "html"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserExtractHtmlTaskInput = FromSchema<typeof inputSchema>;
export type BrowserExtractHtmlTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserExtractHtmlTask extends Task<
  BrowserExtractHtmlTaskInput,
  BrowserExtractHtmlTaskOutput,
  BrowserExtractHtmlTaskConfig
> {
  static override readonly type = "BrowserExtractHtmlTask";
  static override readonly category = "Browser";
  public static override title = "Browser Extract HTML";
  public static override description =
    "Extracts HTML content from a specific element by ref or CSS selector";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserExtractHtmlTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserExtractHtmlTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserExtractHtmlTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    let ref = this.config.ref;
    if (!ref) {
      if (!this.config.selector) {
        throw new TaskConfigurationError(
          "BrowserExtractHtmlTask requires either config.ref or config.selector"
        );
      }
      const found = await ctx.querySelector(this.config.selector);
      if (!found) {
        throw new Error(
          `BrowserExtractHtmlTask could not find an element matching selector: ${this.config.selector}`
        );
      }
      ref = found;
    }
    const html = await ctx.innerHTML(ref);
    return { sessionId: input.sessionId, html };
  }
}
