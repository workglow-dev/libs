/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodingToolContext } from "./context";
import { requireString, resolvePath } from "./context";

export function createWriteTool(context: CodingToolContext): ToolDefinition {
  return {
    name: "write",
    description:
      "Create a file or overwrite it with new content, creating parent directories as needed. " +
      "Use edit for changes to an existing file; use write for new files or complete rewrites.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the cwd" },
        content: { type: "string", description: "The complete file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const path = resolvePath(context, requireString(input, "path"));
      const content = requireString(input, "content");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  };
}
