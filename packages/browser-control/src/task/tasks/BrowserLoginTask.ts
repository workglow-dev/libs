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
  Task,
  TaskConfigSchema,
  TaskConfigurationError,
  TaskFailedError,
} from "@workglow/task-graph";
import { HUMAN_CONNECTOR, resolveHumanConnector, uuid4 } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { assertNavigableUrl, navigationEntitlements } from "../BrowserReachPolicy";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserLoginTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    mode: {
      type: "string",
      enum: ["manual"],
      title: "Login Mode",
      description:
        "The login strategy to use. Manual: the page is opened and a person is asked to log in, then continue",
      default: "manual",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserLoginTaskConfig = TaskConfig & {
  mode?: "manual";
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
    return navigationEntitlements(
      this.runInputData?.url ?? this.defaults.url,
      "Navigates to the login page URL"
    );
  }

  override async execute(
    input: BrowserLoginTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserLoginTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    assertNavigableUrl(input.url, "BrowserLoginTask");
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    // Checked before navigating, so a host that cannot ask a person refuses with the
    // page untouched.
    if (!executeContext.registry.has(HUMAN_CONNECTOR)) {
      throw new TaskConfigurationError(
        "BrowserLoginTask needs a person to log in: register a HUMAN_CONNECTOR in a host that can ask one"
      );
    }
    const connector = resolveHumanConnector(executeContext);

    await ctx.navigate(input.url);
    await executeContext.updateProgress(20, "Navigated to login page");
    await executeContext.updateProgress(50, "Waiting for manual login...");

    // The task waits here until the person says they are done, so the next task
    // runs logged in -- reporting "waiting" and returning at once ran it logged out.
    const response = await connector.send(
      {
        requestId: uuid4(),
        targetHumanId: "default",
        kind: "confirm",
        message: `Log in at ${input.url} in the browser, then continue.`,
        contentSchema: { type: "object", properties: {}, additionalProperties: true },
        contentData: undefined,
        expectsResponse: true,
        mode: "single",
        metadata: { url: input.url },
      },
      executeContext.signal
    );
    if (response.action !== "accept") {
      throw new TaskFailedError(`BrowserLoginTask: login was not completed (${response.action})`);
    }

    return { sessionId: input.sessionId };
  }
}
