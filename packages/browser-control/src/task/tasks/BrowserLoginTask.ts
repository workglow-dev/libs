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
import {
  Entitlements,
  mergeEntitlements,
  Task,
  TaskConfigSchema,
  TaskInvalidInputError,
} from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { assertNavigableUrl, navigationEntitlements } from "../BrowserReachPolicy";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserLoginTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    mode: {
      type: "string",
      enum: ["manual", "credential", "ai"],
      title: "Login Mode",
      description: "The login strategy to use",
      default: "manual",
    },
    credentialName: {
      type: "string",
      title: "Credential Name",
      description: "Name of the stored credential to use (required when mode is 'credential')",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserLoginTaskConfig = TaskConfig & {
  mode?: "manual" | "credential" | "ai";
  credentialName?: string;
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
      description: "The login page URL to navigate to",
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
  },
  required: ["sessionId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserLoginTaskInput = FromSchema<typeof inputSchema>;
export type BrowserLoginTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserLoginTask extends Task<
  BrowserLoginTaskInput,
  BrowserLoginTaskOutput,
  BrowserLoginTaskConfig
> {
  static override readonly type = "BrowserLoginTask";
  static override readonly category = "Browser";
  public static override title = "Browser Login";
  public static override description =
    "Logs into a website using manual, credential, or AI-driven login strategies";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override hasDynamicEntitlements = true;

  public static override configSchema(): DataPortSchema {
    return browserLoginTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  public static override entitlements(): TaskEntitlements {
    return navigationEntitlements(undefined, "Navigates to the login page URL");
  }

  public override entitlements(): TaskEntitlements {
    const base = navigationEntitlements(
      this.runInputData?.url ?? this.defaults.url,
      "Navigates to the login page URL"
    );
    if (this.config.mode === "credential") {
      return mergeEntitlements(base, {
        entitlements: [
          {
            id: Entitlements.BROWSER_CONTROL_CREDENTIAL,
            reason: "Accesses stored credentials for login",
          },
        ],
      });
    }
    return base;
  }

  override async execute(
    input: BrowserLoginTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserLoginTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    assertNavigableUrl(input.url, "BrowserLoginTask");
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    const mode = this.config.mode ?? "manual";

    await ctx.navigate(input.url);
    await executeContext.updateProgress(20, "Navigated to login page");

    switch (mode) {
      case "manual":
        await executeContext.updateProgress(50, "Waiting for manual login...");
        // Placeholder for future HumanInputTask integration
        break;
      case "credential":
        throw new Error("Credential-based login mode is not yet implemented");
      case "ai":
        throw new Error("AI-driven login mode is not yet implemented");
    }

    return { sessionId: input.sessionId };
  }
}
