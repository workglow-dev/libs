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
      description: "The element reference to get the attribute from",
    },
    attribute: {
      type: "string",
      title: "Attribute Name",
      description: "The name of the attribute to retrieve",
    },
  },
  required: ["sessionId", "ref", "attribute"],
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
    value: {
      type: ["string", "null"],
      title: "Value",
      description: "The attribute value, or null if not present",
    },
  },
  required: ["sessionId", "value"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserAttributeTaskInput = FromSchema<typeof inputSchema>;
export type BrowserAttributeTaskOutput = { sessionId: string; value: string | null };

export class BrowserAttributeTask extends Task<
  BrowserAttributeTaskInput,
  BrowserAttributeTaskOutput,
  TaskConfig
> {
  static override readonly type = "BrowserAttributeTask";
  static override readonly category = "Browser";
  public static override title = "Browser Attribute";
  public static override description = "Retrieves the value of an attribute from a browser element";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return TaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserAttributeTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserAttributeTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const value = await readWithinReach(ctx, "BrowserAttributeTask", () =>
      ctx.attribute(input.ref, input.attribute)
    );
    return { sessionId: input.sessionId, value };
  }
}
