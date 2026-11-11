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

const browserExtractTextTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    ref: {
      type: "string",
      title: "Element Ref",
      description:
        "The element reference to extract text from (extracts from full page if not provided)",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserExtractTextTaskConfig = TaskConfig & {
  ref?: string;
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
    text: {
      type: "string",
      title: "Text",
      description: "The extracted text content",
    },
  },
  required: ["sessionId", "text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserExtractTextTaskInput = FromSchema<typeof inputSchema>;
export type BrowserExtractTextTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserExtractTextTask extends Task<
  BrowserExtractTextTaskInput,
  BrowserExtractTextTaskOutput,
  BrowserExtractTextTaskConfig
> {
  static override readonly type = "BrowserExtractTextTask";
  static override readonly category = "Browser";
  public static override title = "Browser Extract Text";
  public static override description =
    "Extracts text content from a specific element or the full page";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserExtractTextTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserExtractTextTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserExtractTextTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    let ref = this.config.ref;
    if (!ref) {
      const bodyRef = await ctx.querySelector("body");
      if (!bodyRef) {
        throw new Error("BrowserExtractTextTask: could not find body element");
      }
      ref = bodyRef;
    }
    const text = await readWithinReach(ctx, "BrowserExtractTextTask", () => ctx.textContent(ref));
    return { sessionId: input.sessionId, text: text ?? "" };
  }
}
