/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskConfigSchema, TaskConfigurationError } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserCloseTabTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    tabId: {
      type: "string",
      title: "Tab ID",
      description: "The tab ID to close (closes current tab if not provided)",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserCloseTabTaskConfig = TaskConfig & {
  tabId?: string;
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
  },
  required: ["sessionId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserCloseTabTaskInput = FromSchema<typeof inputSchema>;
export type BrowserCloseTabTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserCloseTabTask extends Task<
  BrowserCloseTabTaskInput,
  BrowserCloseTabTaskOutput,
  BrowserCloseTabTaskConfig
> {
  static override readonly type = "BrowserCloseTabTask";
  static override readonly category = "Browser";
  public static override title = "Browser Close Tab";
  public static override description = "Closes a browser tab by tab ID";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserCloseTabTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserCloseTabTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserCloseTabTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    if (!this.config.tabId) {
      throw new TaskConfigurationError("BrowserCloseTabTask requires config.tabId");
    }
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    await ctx.closeTab(this.config.tabId);
    return { sessionId: input.sessionId };
  }
}
