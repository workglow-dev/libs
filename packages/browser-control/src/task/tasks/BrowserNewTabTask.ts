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
import { Task, TaskConfigSchema } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import {
  assertLandedWithinReach,
  assertNavigableUrl,
  assertResolvesPublic,
  navigationEntitlements,
} from "../BrowserReachPolicy";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const NAVIGATE_REASON = "Opens a URL in a new browser tab";

const browserNewTabTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserNewTabTaskConfig = TaskConfig;

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
      title: "URL",
      description: "Optional URL to open in the new tab",
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
    tabId: {
      type: "string",
      title: "Tab ID",
      description: "The unique identifier for the new tab",
    },
  },
  required: ["sessionId", "tabId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserNewTabTaskInput = FromSchema<typeof inputSchema>;
export type BrowserNewTabTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserNewTabTask extends Task<
  BrowserNewTabTaskInput,
  BrowserNewTabTaskOutput,
  BrowserNewTabTaskConfig
> {
  static override readonly type = "BrowserNewTabTask";
  static override readonly category = "Browser";
  public static override title = "Browser New Tab";
  public static override description = "Opens a new browser tab and returns its tab ID";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return browserNewTabTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  public static override hasDynamicEntitlements: boolean = true;

  /** Read before any input is known, so it names what a url would need. */
  public static override entitlements(): TaskEntitlements {
    return navigationEntitlements(undefined, NAVIGATE_REASON);
  }

  /** A blank tab reaches nothing; a url is declared as {@link BrowserNavigateTask} declares it. */
  public override entitlements(): TaskEntitlements {
    const url = this.runInputData?.url ?? this.defaults.url;
    if (typeof url !== "string" || url.length === 0) return { entitlements: [] };
    return navigationEntitlements(url, NAVIGATE_REASON);
  }

  override async execute(
    input: BrowserNewTabTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserNewTabTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    if (input.url) {
      assertNavigableUrl(input.url, "BrowserNewTabTask");
      await assertResolvesPublic(input.url, "BrowserNewTabTask");
    }
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const tabInfo = await ctx.newTab(input.url);
    if (input.url) {
      try {
        await assertLandedWithinReach(ctx, input.url, tabInfo.url, "BrowserNewTabTask");
      } catch (err) {
        // Closed so no later task can read it (a single-page backend ends the session).
        // A failed close must not replace the refusal.
        await ctx.closeTab(tabInfo.tabId).catch(() => undefined);
        throw err;
      }
    }
    return { sessionId: input.sessionId, tabId: tabInfo.tabId };
  }
}
