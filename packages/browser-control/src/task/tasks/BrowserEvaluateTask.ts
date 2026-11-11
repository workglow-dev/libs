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
import { Entitlements, Task, TaskConfigSchema } from "@workglow/task-graph";
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
    expression: {
      type: "string",
      title: "Expression",
      description: "The JavaScript expression to evaluate in the page context",
    },
  },
  required: ["sessionId", "expression"],
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
    result: {
      title: "Result",
      description: "The result of the evaluated expression",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserEvaluateTaskInput = FromSchema<typeof inputSchema>;
export type BrowserEvaluateTaskOutput = { sessionId: string; result: unknown };

export class BrowserEvaluateTask extends Task<
  BrowserEvaluateTaskInput,
  BrowserEvaluateTaskOutput,
  TaskConfig
> {
  static override readonly type = "BrowserEvaluateTask";
  static override readonly category = "Browser";
  public static override title = "Browser Evaluate";
  public static override description =
    "Evaluates a JavaScript expression in the browser page context";
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

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        {
          id: Entitlements.BROWSER_CONTROL_EVALUATE,
          reason: "Evaluates arbitrary JavaScript in the browser context",
        },
      ],
    };
  }

  override async execute(
    input: BrowserEvaluateTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserEvaluateTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const result = await readWithinReach(ctx, "BrowserEvaluateTask", () =>
      ctx.evaluate(input.expression)
    );
    return { sessionId: input.sessionId, result };
  }
}
