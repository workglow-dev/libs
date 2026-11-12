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
import type { AccessibilityTree } from "../IBrowserContext";

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
    tree: {
      type: "object",
      title: "Accessibility Tree",
      description: "The accessibility tree of the current page",
      additionalProperties: true,
    },
  },
  required: ["sessionId", "tree"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserSnapshotTaskInput = FromSchema<typeof inputSchema>;
export type BrowserSnapshotTaskOutput = { sessionId: string; tree: AccessibilityTree };

export class BrowserSnapshotTask extends Task<
  BrowserSnapshotTaskInput,
  BrowserSnapshotTaskOutput,
  TaskConfig
> {
  static override readonly type = "BrowserSnapshotTask";
  static override readonly category = "Browser";
  public static override title = "Browser Snapshot";
  public static override description = "Returns the accessibility tree of the current browser page";
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
    input: BrowserSnapshotTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserSnapshotTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const tree = await readWithinReach(ctx, "BrowserSnapshotTask", () => ctx.snapshot());
    return { sessionId: input.sessionId, tree };
  }
}
