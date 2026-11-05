/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import { Entitlements, Task, TaskConfigSchema, TaskInvalidInputError } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserNavigateTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    waitUntil: {
      type: "string",
      enum: ["load", "domcontentloaded", "networkidle"],
      title: "Wait Until",
      description: "When to consider navigation complete",
      default: "load",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserNavigateTaskConfig = TaskConfig & {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
};

const inputSchema = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "The browser session to use",
    },
    url: {
      type: "string",
      format: "uri",
      title: "URL",
      description: "The URL to navigate to",
    },
  },
  required: ["sessionId", "url"],
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
    title: {
      type: "string",
      title: "Page Title",
      description: "The title of the navigated page",
    },
    url: {
      type: "string",
      title: "URL",
      description: "The current URL after navigation",
    },
  },
  required: ["sessionId", "title", "url"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserNavigateTaskInput = FromSchema<typeof inputSchema>;
export type BrowserNavigateTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserNavigateTask extends Task<
  BrowserNavigateTaskInput,
  BrowserNavigateTaskOutput,
  BrowserNavigateTaskConfig
> {
  static override readonly type = "BrowserNavigateTask";
  static override readonly category = "Browser";
  public static override title = "Browser Navigate";
  public static override description =
    "Navigates the browser to a URL and returns the page title and URL";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserNavigateTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.BROWSER_CONTROL_NAVIGATE, reason: "Navigates to a URL in the browser" },
      ],
    };
  }

  override async execute(
    input: BrowserNavigateTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserNavigateTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const parsed = new URL(input.url, "https://placeholder");
    if (parsed.protocol === "javascript:") {
      throw new TaskInvalidInputError("BrowserNavigateTask: javascript: URLs are not allowed");
    }
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const waitUntil = this.config.waitUntil ?? "load";
    await ctx.navigate(input.url, { waitUntil });
    const title = await ctx.title();
    const url = await ctx.currentUrl();
    return { sessionId: input.sessionId, title, url };
  }
}
