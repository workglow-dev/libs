/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { ToolCallError, ToolResultContent } from "@workglow/ai";
import { opendir, readFile, stat } from "node:fs/promises";
import type { CodingToolContext } from "./context";
import { optionalInteger, requireString, resolvePath } from "./context";
import {
  countLines,
  lineAt,
  lineStart,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncateHead,
} from "./truncate";

/** Bytes sampled to decide a file is binary. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Largest image handed to the model. Providers cap an image at about 5 MB and
 * bill it on every later round of the turn, so a bigger one is refused with a
 * way to shrink it rather than sent to fail.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/**
 * Past this a file is not loaded at all: a page is cut to 50KB anyway, but
 * finding it means holding the whole file, and a multi-gigabyte log would take
 * the agent's memory with it.
 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

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

/** The longest start of `text` that fits `maxBytes` of UTF-8, never splitting a character. */
function headWithinBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
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
      // The schema says so, but a tool's arguments reach it unchecked, and a zero
      // offset would slice from the end of the file.
      if (offset < 1) throw new ToolCallError(`offset must be 1 or more, got ${offset}`);
      if (limit !== undefined && limit < 1) {
        throw new ToolCallError(`limit must be 1 or more, got ${limit}`);
      }

      const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
        // Only a missing path is "not found"; anything else (no permission, an
        // I/O error) is reported as it is, so the model does not take an
        // unreadable file for one it may create.
        if (err.code === "ENOENT") throw new ToolCallError(`File not found: ${path}`);
        throw new ToolCallError(`Could not read ${path}: ${err.message}`);
      });
      if (info.isDirectory()) {
        // Kept as they are read, never whole: a directory can hold millions of
        // entries and only the first MAX_OUTPUT_LINES are ever shown, so the rest
        // are only counted.
        const names: string[] = [];
        let total = 0;
        for await (const entry of await opendir(path)) {
          total++;
          if (names.length < MAX_OUTPUT_LINES) {
            names.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
          }
        }
        names.sort();
        const listing = truncateHead(names.join("\n"));
        // Past the cap the names kept are the first the directory returned, not
        // the first by name, and the model is told so.
        const order = total > names.length ? ", in directory order rather than by name" : "";
        const more =
          listing.keptLines < total
            ? `\n\n[Showing ${listing.keptLines} of ${total} entries${order}. Use bash (ls, find) to see the rest.]`
            : "";
        return `${path} is a directory:\n${listing.text}${more}`;
      }
      // A device or a pipe has no end to read to (/dev/zero would fill memory).
      if (!info.isFile()) throw new ToolCallError(`${path} is not a regular file`);
      if (info.size > MAX_READ_BYTES) {
        throw new ToolCallError(
          `${path} is ${info.size} bytes, too large to read whole. ` +
            "Use bash to look at part of it (head, tail, sed -n 'X,Yp', grep)."
        );
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
      const text = buffer.toString("utf8");
      // The window is cut out of the text by line position rather than by
      // splitting the file: a file of short lines can hold millions of them.
      const totalLines = countLines(text);
      if (offset > totalLines) {
        throw new ToolCallError(
          `offset ${offset} is past the end of ${path} (${totalLines} lines)`
        );
      }
      const after = limit === undefined ? totalLines + 1 : Math.min(offset + limit, totalLines + 1);
      const from = lineStart(text, offset);
      const to =
        after > totalLines
          ? text.endsWith("\n")
            ? text.length - 1
            : text.length
          : lineStart(text, after) - 1;
      const shown = truncateHead(text.slice(from, to));

      if (shown.keptLines === 0) {
        // One line larger than the whole budget: show its start and say how to see the rest.
        const first = lineAt(text, offset);
        const head = headWithinBytes(first, MAX_OUTPUT_BYTES);
        return (
          `${head}\n\n[Line ${offset} is ${first.length} characters; showing the first ` +
          `${head.length}. Use bash (e.g. cut -c or head -c) to read the rest.]`
        );
      }
      const last = offset + shown.keptLines - 1;
      if (shown.truncated || (limit !== undefined && last < totalLines)) {
        return (
          `${shown.text}\n\n[Showing lines ${offset}-${last} of ${totalLines}. ` +
          `Use offset=${last + 1} to continue.]`
        );
      }
      return shown.text;
    },
  };
}
