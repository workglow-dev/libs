/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Output limits shared by every tool. They are pi's and opencode's numbers on
 * purpose: the eval compares loops, and a tool that showed the model five
 * times more output than the other harnesses' would be measuring the tool.
 */
export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

export interface Truncated {
  readonly text: string;
  readonly truncated: boolean;
  /** Lines in the input, before truncation. */
  readonly totalLines: number;
  /** Lines kept. */
  readonly keptLines: number;
  /** The first kept line is only the end of a line too long for the budget. */
  readonly partialLine: boolean;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The first lines of `text` that fit both limits. A read wants the head: the
 * model continues from where it stopped with `offset`.
 */
export function truncateHead(
  text: string,
  maxLines: number = MAX_OUTPUT_LINES,
  maxBytes: number = MAX_OUTPUT_BYTES
): Truncated {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = byteLength(line) + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return {
    text: kept.join("\n"),
    truncated: kept.length < lines.length,
    totalLines: lines.length,
    keptLines: kept.length,
    partialLine: false,
  };
}

/** The end of `line` within `maxBytes` of UTF-8, cut on a character boundary. */
function tailWithinBytes(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= maxBytes) return line;
  let start = buffer.length - maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx; start on the next character instead.
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/**
 * The last lines of `text` that fit both limits. A command wants the tail:
 * the error, the test summary and the exit status are at the end. A last line
 * longer than the whole budget (minified JSON, a progress bar redrawn with
 * carriage returns) keeps its end, rather than leaving nothing to show.
 */
export function truncateTail(
  text: string,
  maxLines: number = MAX_OUTPUT_LINES,
  maxBytes: number = MAX_OUTPUT_BYTES
): Truncated {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= maxLines) break;
    const size = byteLength(lines[i]!) + 1;
    if (bytes + size > maxBytes) {
      if (kept.every((line) => line.length === 0)) {
        kept.push(tailWithinBytes(lines[i]!, maxBytes - bytes - 1));
        partial = true;
      }
      break;
    }
    kept.push(lines[i]!);
    bytes += size;
  }
  kept.reverse();
  return {
    text: kept.join("\n"),
    truncated: partial || kept.length < lines.length,
    totalLines: lines.length,
    keptLines: kept.length,
    partialLine: partial,
  };
}
