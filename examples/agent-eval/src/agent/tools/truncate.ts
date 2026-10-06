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
  };
}

/**
 * The last lines of `text` that fit both limits. A command wants the tail:
 * the error, the test summary and the exit status are at the end.
 */
export function truncateTail(
  text: string,
  maxLines: number = MAX_OUTPUT_LINES,
  maxBytes: number = MAX_OUTPUT_BYTES
): Truncated {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = byteLength(lines[i]!) + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(lines[i]!);
    bytes += size;
  }
  kept.reverse();
  return {
    text: kept.join("\n"),
    truncated: kept.length < lines.length,
    totalLines: lines.length,
    keptLines: kept.length,
  };
}
