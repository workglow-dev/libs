/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What `git status --porcelain` says about the working tree, as the release
 * chain needs to read it: whether anything at all differs from the commit, and
 * which paths, so a refusal can name them instead of saying "not clean".
 */
export interface TreeState {
  readonly clean: boolean;
  readonly paths: readonly string[];
}

/**
 * Reads porcelain v1 output into {@link TreeState}.
 *
 * Each line is `XY <path>`, or `XY <old> -> <new>` for a rename or copy; the
 * destination is the interesting half, since that is the file that would be
 * packed. Blank lines (including the trailing one) are dropped, so an empty
 * tree reads as clean rather than as one nameless change.
 */
export function readTreeState(porcelain: string): TreeState {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    const entry = line.slice(3);
    const arrow = entry.lastIndexOf(" -> ");
    paths.push(arrow === -1 ? entry : entry.slice(arrow + 4));
  }
  return { clean: paths.length === 0, paths };
}

/** At most `limit` paths, with a count of what was elided. */
export function summarizePaths(paths: readonly string[], limit = 10): string {
  const shown = paths.slice(0, limit).map((p) => `    ${p}`);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n    … and ${rest} more` : shown.join("\n");
}
