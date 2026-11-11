/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskConfigSchema } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { readWithinReach } from "../BrowserReachPolicy";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserScreenshotTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    format: {
      type: "string",
      enum: ["png", "jpeg"],
      title: "Format",
      description: "The image format for the screenshot",
      default: "png",
    },
    fullPage: {
      type: "boolean",
      title: "Full Page",
      description: "Whether to capture the full scrollable page",
      default: false,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserScreenshotTaskConfig = TaskConfig & {
  format?: "png" | "jpeg";
  fullPage?: boolean;
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
    image: {
      type: "string",
      format: "binary",
      title: "Image",
      description: "The screenshot image data",
    },
  },
  required: ["sessionId", "image"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserScreenshotTaskInput = FromSchema<typeof inputSchema>;
export type BrowserScreenshotTaskOutput = { sessionId: string; image: Uint8Array };

export class BrowserScreenshotTask extends Task<
  BrowserScreenshotTaskInput,
  BrowserScreenshotTaskOutput,
  BrowserScreenshotTaskConfig
> {
  static override readonly type = "BrowserScreenshotTask";
  static override readonly category = "Browser";
  public static override title = "Browser Screenshot";
  public static override description = "Takes a screenshot of the current browser page";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserScreenshotTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserScreenshotTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserScreenshotTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const format = this.config.format ?? "png";
    const fullPage = this.config.fullPage ?? false;
    const image = await readWithinReach(ctx, "BrowserScreenshotTask", () =>
      ctx.screenshot({ format, fullPage })
    );
    return { sessionId: input.sessionId, image };
  }
}
