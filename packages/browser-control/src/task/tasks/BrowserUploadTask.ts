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
import { containUploadPaths, uploadEntitlements } from "../BrowserReachPolicy";
import { BrowserSessionRegistry } from "../BrowserSessionRegistry";

const browserUploadTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    roots: {
      type: "array",
      items: { type: "string" },
      title: "Roots",
      description:
        "Directories an upload path must resolve inside (after symlink resolution). Defaults to the process working directory",
      "x-ui-hidden": true,
    },
    allowAnyRoot: {
      type: "boolean",
      title: "Allow Any Root",
      description: "Skip root containment entirely and upload any file the process can open",
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type BrowserUploadTaskConfig = TaskConfig & {
  roots?: string[];
  allowAnyRoot?: boolean;
};

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
      description: "The file input element reference to upload to",
    },
    filePaths: {
      type: "array",
      items: {
        type: "string",
      },
      title: "File Paths",
      description: "The local file paths to upload",
    },
  },
  required: ["sessionId", "ref", "filePaths"],
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

export type BrowserUploadTaskInput = FromSchema<typeof inputSchema>;
export type BrowserUploadTaskOutput = FromSchema<typeof outputSchema>;

export class BrowserUploadTask extends Task<
  BrowserUploadTaskInput,
  BrowserUploadTaskOutput,
  BrowserUploadTaskConfig
> {
  static override readonly type = "BrowserUploadTask";
  static override readonly category = "Browser";
  public static override title = "Browser Upload";
  public static override description =
    "Uploads one or more files to a file input element in the browser";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return uploadEntitlements(undefined);
  }

  /** `filesystem:read` scoped to each path once the paths are known. */
  public override entitlements(): TaskEntitlements {
    return uploadEntitlements(this.runInputData?.filePaths ?? this.defaults.filePaths);
  }

  public static override configSchema(): DataPortSchema {
    return browserUploadTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(
    input: BrowserUploadTaskInput,
    executeContext: IExecuteContext
  ): Promise<BrowserUploadTaskOutput> {
    executeContext.resourceScope?.touch(`browser:${input.sessionId}`);
    const ctx = BrowserSessionRegistry.get(input.sessionId);
    // Contained like FileLoaderTask: a graph can name any path, and whatever is
    // uploaded is handed to the page.
    const filePaths = await containUploadPaths(input.filePaths, {
      roots: this.config.roots,
      allowAnyRoot: this.config.allowAnyRoot,
    });
    await ctx.uploadFile(input.ref, filePaths);
    return { sessionId: input.sessionId };
  }
}
