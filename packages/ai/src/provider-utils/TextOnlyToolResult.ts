/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentBlockInToolResultBody } from "../task/ChatMessage";

/**
 * What a model that reads text only is shown in place of an image a tool
 * returned. Leaving the image out without a word reads as a tool that returned
 * nothing, which is the result most likely to make the model call it again;
 * the note says the call succeeded and what it produced.
 */
export function omittedToolImageNote(mimeType: string): string {
  return `[${mimeType} image returned; this model reads text only]`;
}

/**
 * A tool result's blocks as one string for a model that reads text only, each
 * block on its own line in the order the tool returned them: text as written,
 * an image as {@link omittedToolImageNote} rather than its base64, and any
 * other block (a nested `tool_use`) as JSON, since it is data the tool returned.
 */
export function textOnlyToolResult(content: ReadonlyArray<ContentBlockInToolResultBody>): string {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) lines.push(block.text);
    } else if (block.type === "image") {
      lines.push(omittedToolImageNote(block.mimeType));
    } else {
      lines.push(JSON.stringify(block));
    }
  }
  return lines.join("\n");
}
