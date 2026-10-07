/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { ToolCallError, ToolResultContent } from "@workglow/ai";
import { readdir, readFile, stat } from "node:fs/promises";
import type { CodingToolContext } from "./context";
import { optionalInteger, requireString, resolvePath } from "./context";
import { MAX_OUTPUT_BYTES, truncateHead } from "./truncate";

/** Bytes sampled to decide a file is binary. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Largest image handed to the model. Providers cap an image at about 5 MB and
 * bill it on every later round of the turn, so a bigger one is refused with a
 * way to shrink it rather than sent to fail.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** The image formats every vision provider takes, recognised by their leading bytes. */
export function imageMimeType(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "image/gif";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return sample.includes(0);
}

export function createReadTool(context: CodingToolContext): ToolDefinition {
  return {
    name: "read",
    description:
      "Read a text file. Output is truncated to 2000 lines or 50KB, whichever comes first; " +
      "use offset and limit to page through a longer file. Lines are shown as they are, " +
      "without line numbers." +
      (context.images
        ? " An image (png, jpg, gif, webp) is shown to you as the image itself."
        : ""),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the cwd" },
        offset: { type: "integer", minimum: 1, description: "First line to show (1-based)" },
        limit: { type: "integer", minimum: 1, description: "Maximum lines to show" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const path = resolvePath(context, requireString(input, "path"));
      const offset = optionalInteger(input, "offset") ?? 1;
      const limit = optionalInteger(input, "limit");

      const info = await stat(path).catch(() => undefined);
      if (info === undefined) throw new ToolCallError(`File not found: ${path}`);
      if (info.isDirectory()) {
        const entries = await readdir(path, { withFileTypes: true });
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort();
        return `${path} is a directory:\n${names.join("\n")}`;
      }

      const buffer = await readFile(path);
      const mimeType = context.images ? imageMimeType(buffer) : undefined;
      if (mimeType !== undefined) {
        if (buffer.length > MAX_IMAGE_BYTES) {
          throw new ToolCallError(
            `${path} is a ${buffer.length}-byte image, over the ${MAX_IMAGE_BYTES}-byte limit. ` +
              "Shrink it first (e.g. with Python's PIL) and read the smaller copy."
          );
        }
        return new ToolResultContent([
          { type: "text", text: `Image: ${path} (${mimeType}, ${buffer.length} bytes)` },
          { type: "image", mimeType, data: buffer.toString("base64") },
        ]);
      }
      if (looksBinary(buffer)) {
        throw new ToolCallError(`${path} is a binary file (${buffer.length} bytes)`);
      }
      const lines = buffer.toString("utf8").split("\n");
      if (offset > lines.length) {
        throw new ToolCallError(
          `offset ${offset} is past the end of ${path} (${lines.length} lines)`
        );
      }
      const window = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
      const shown = truncateHead(window.join("\n"));

      if (shown.keptLines === 0 && window.length > 0) {
        // One line larger than the whole budget: show its start and say how to see the rest.
        const head = window[0]!.slice(0, MAX_OUTPUT_BYTES);
        return (
          `${head}\n\n[Line ${offset} is ${window[0]!.length} characters; showing the first ` +
          `${head.length}. Use bash (e.g. cut -c or head -c) to read the rest.]`
        );
      }
      const last = offset + shown.keptLines - 1;
      if (shown.truncated || (limit !== undefined && last < lines.length)) {
        return (
          `${shown.text}\n\n[Showing lines ${offset}-${last} of ${lines.length}. ` +
          `Use offset=${last + 1} to continue.]`
        );
      }
      return shown.text;
    },
  };
}
