/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { createBashTool } from "./bash";
import type { CodingToolContext } from "./context";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";

/**
 * The toolset the eval hands AgentTask: read, bash, edit, write — pi's default
 * four, with its limits. Holding the tools to pi's means a gap between the
 * Workglow and pi columns is a gap in the loop around them; opencode's richer
 * set (grep, glob, todo, subagents, fuzzier edit) is part of what its column
 * measures.
 */
export function createCodingTools(context: CodingToolContext): ToolDefinition[] {
  return [
    createReadTool(context),
    createBashTool(context),
    createEditTool(context),
    createWriteTool(context),
  ];
}
