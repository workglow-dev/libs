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

// Lines are walked with indexOf rather than split: a capped output or an allowed
// file of short lines can hold millions of them, and an array of every line is
// many times the text's own size, while only the first or last few are kept.

/** Where the text's lines end: a final newline ends the last line rather than starting another. */
function bodyEnd(text: string): number {
  return text.endsWith("\n") ? text.length - 1 : text.length;
}

/** The number of lines in `text`, counted without materializing them. */
export function countLines(text: string): number {
  const end = bodyEnd(text);
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < end; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/** The index where 1-based line `n` starts; `n` must be at most {@link countLines}. */
export function lineStart(text: string, n: number): number {
  let at = 0;
  for (let line = 1; line < n; line++) at = text.indexOf("\n", at) + 1;
  return at;
}

/** Line `n` (1-based) of `text`, without its newline. */
export function lineAt(text: string, n: number): string {
  const start = lineStart(text, n);
  const next = text.indexOf("\n", start);
  return text.slice(start, next === -1 || next > bodyEnd(text) ? bodyEnd(text) : next);
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
  const end = bodyEnd(text);
  const totalLines = countLines(text);
  const kept: string[] = [];
  let bytes = 0;
  for (let at = 0; kept.length < totalLines;) {
    const next = text.indexOf("\n", at);
    const lineEnd = next === -1 || next > end ? end : next;
    const line = text.slice(at, lineEnd);
    // Each line costs its newline, except a last line the text does not end with.
    const size = byteLength(line) + (lineEnd === end && !text.endsWith("\n") ? 0 : 1);
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
    at = lineEnd + 1;
  }
  const truncated = kept.length < totalLines;
  return {
    // The final newline stays when the last line is shown.
    text: kept.join("\n") + (!truncated && text.endsWith("\n") ? "\n" : ""),
    truncated,
    totalLines,
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
  const totalLines = countLines(text);
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  // Walked from the end: `end` is where the current line stops.
  for (let end = bodyEnd(text); kept.length < totalLines;) {
    if (kept.length >= maxLines) break;
    const previous = end === 0 ? -1 : text.lastIndexOf("\n", end - 1);
    const line = text.slice(previous + 1, end);
    // Each line costs its newline, except a last line the text does not end with.
    const newline = kept.length === 0 && !text.endsWith("\n") ? 0 : 1;
    const size = byteLength(line) + newline;
    if (bytes + size > maxBytes) {
      // The partial line still costs its newline once joined, so without room
      // for even that the output would exceed the budget (e.g. blank lines
      // with nothing to trim). Leave it out rather than grow past maxBytes.
      const allowance = maxBytes - bytes - newline;
      if (allowance < 0) break;
      if (kept.every((shown) => shown.length === 0)) {
        kept.push(tailWithinBytes(line, allowance));
        partial = true;
      }
      break;
    }
    kept.push(line);
    bytes += size;
    end = previous;
  }
  kept.reverse();
  return {
    // The tail always ends on the last line, so its final newline stays.
    text: kept.join("\n") + (kept.length > 0 && text.endsWith("\n") ? "\n" : ""),
    truncated: partial || kept.length < totalLines,
    totalLines,
    keptLines: kept.length,
    partialLine: partial,
  };
}
