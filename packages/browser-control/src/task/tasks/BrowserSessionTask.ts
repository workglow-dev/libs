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
  TaskConfigurationError,
} from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";
import { getBrowserDeps } from "../BrowserTaskDeps";

const browserSessionTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    backend: {
      type: "string",
      enum: ["local", "cloud", "electron-native"],
      title: "Backend",
      description: "The browser backend to use",
    },
    projectId: {
      type: "string",
      title: "Project ID",
      description: "Project identifier for profile storage",
    },
    profileName: {
      type: "string",
      title: "Profile Name",
      description: "Named browser profile to use",
    },
    headless: {
      type: "boolean",
      title: "Headless",
      description: "Run the browser in headless mode",
      default: true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserSessionTaskConfig = TaskConfig & {
  backend?: "local" | "cloud" | "electron-native";
  projectId?: string;
  profileName?: string;
  headless?: boolean;
};

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      title: "Session ID",
      description: "The unique identifier for the created browser session",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserSessionTaskInput = FromSchema<typeof inputSchema>;
export type BrowserSessionTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserSessionTask extends Task<
  BrowserSessionTaskInput,
  BrowserSessionTaskOutput,
  BrowserSessionTaskConfig
> {
  static override readonly type = "BrowserSessionTask";
  static override readonly category = "Browser";
  public static override title = "Browser Session";
  public static override description = "Creates a new browser session and returns its session ID";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override hasDynamicEntitlements = true;

  public static override configSchema(): DataPortSchema {
    return browserSessionTaskConfigSchema;
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
        { id: Entitlements.BROWSER_CONTROL, reason: "Creates and manages a browser session" },
      ],
    };
  }

  public override entitlements(): TaskEntitlements {
    const base = BrowserSessionTask.entitlements();
    const backend = this.config.backend;
    if (backend === "local" || backend === "electron-native") {
      return mergeEntitlements(base, {
        entitlements: [
          { id: Entitlements.BROWSER_CONTROL_LOCAL, reason: "Launches a local browser process" },
        ],
      });
    }
    if (backend === "cloud") {
      return mergeEntitlements(base, {
        entitlements: [
          {
            id: Entitlements.BROWSER_CONTROL_CLOUD,
            reason: "Connects to a remote cloud browser service",
          },
        ],
      });
    }
    // Backend not yet determined — require both to be safe
    return mergeEntitlements(
      base,
      mergeEntitlements(
        {
          entitlements: [
            { id: Entitlements.BROWSER_CONTROL_LOCAL, reason: "Launches a local browser process" },
          ],
        },
        {
          entitlements: [
            {
              id: Entitlements.BROWSER_CONTROL_CLOUD,
              reason: "Connects to a remote cloud browser service",
            },
          ],
        }
      )
    );
  }

  override async execute(
    _input: BrowserSessionTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserSessionTaskOutput> {
    const deps = getBrowserDeps();

    const backend = this.config.backend ?? deps.defaultBackend;

    if (!deps.availableBackends.includes(backend)) {
      throw new TaskConfigurationError(
        `BrowserSessionTask: backend "${backend}" is not available. Available backends: ${deps.availableBackends.join(", ")}`
      );
    }

    const options = {
      backend,
      projectId: this.config.projectId,
      profileName: this.config.profileName,
      headless: this.config.headless ?? true,
    };

    const ctx = deps.createContext(options);
    await ctx.connect(options);

    const sessionId = BrowserSessionRegistry.register(ctx);

    const resourceKey = `browser:${sessionId}`;
    executeContext.resourceScope?.register(resourceKey, async () => {
      await ctx.disconnect();
      BrowserSessionRegistry.unregister(sessionId);
    });
    executeContext.resourceScope?.touch(resourceKey);

    return { sessionId };
  }
}
