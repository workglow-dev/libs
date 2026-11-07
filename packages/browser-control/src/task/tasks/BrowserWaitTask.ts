/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskConfigSchema, TaskConfigurationError } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserWaitTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    waitFor: {
      type: "string",
      enum: ["navigation", "selector", "idle"],
      title: "Wait For",
      description: "The condition to wait for",
      default: "idle",
    },
    selector: {
      type: "string",
      title: "Selector",
      description: "CSS selector to wait for (required when waitFor is 'selector')",
    },
    timeout: {
      type: "number",
      title: "Timeout",
      description: "Maximum time to wait in milliseconds",
      default: 30000,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserWaitTaskConfig = TaskConfig & {
  waitFor?: "navigation" | "selector" | "idle";
  selector?: string;
  timeout?: number;
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

export type BrowserWaitTaskInput = FromSchema<typeof inputSchema>;
export type BrowserWaitTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserWaitTask extends Task<
  BrowserWaitTaskInput,
  BrowserWaitTaskOutput,
  BrowserWaitTaskConfig
> {
  static override readonly type = "BrowserWaitTask";
  static override readonly category = "Browser";
  public static override title = "Browser Wait";
  public static override description =
    "Waits for a navigation, selector, or network idle state in the browser";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserWaitTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserWaitTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserWaitTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const waitFor = this.config.waitFor ?? "idle";
    const timeout = this.config.timeout ?? 30000;

    switch (waitFor) {
      case "navigation":
        await ctx.waitForNavigation({ timeout });
        break;
      case "selector": {
        const selector = this.config.selector;
        if (!selector) {
          throw new TaskConfigurationError(
            "BrowserWaitTask: selector is required when waitFor is 'selector'"
          );
        }
        await ctx.waitForSelector(selector, { timeout });
        break;
      }
      case "idle":
        await ctx.waitForIdle({ timeout });
        break;
    }

    return { sessionId: input.sessionId };
  }
}
