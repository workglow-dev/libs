/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Commands a coding task commonly reaches for. A benchmark image ships some and
 * not others (`python3` without `python`, no `rg`), and a model that guesses
 * spends a round on "command not found" each time.
 */
export const PROBED_COMMANDS: readonly string[] = [
  "python3",
  "python",
  "pip3",
  "pip",
  "node",
  "npm",
  "git",
  "rg",
  "gcc",
  "g++",
  "make",
  "cmake",
  "cargo",
  "go",
  "java",
  "file",
  "xxd",
  "strings",
  "7zz",
  "7z",
];

export interface CommandInventory {
  readonly found: readonly string[];
  readonly missing: readonly string[];
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Which of `commands` resolve to an executable on `path` (a PATH-style list). */
export function probeCommands(commands: readonly string[], path: string): CommandInventory {
  const dirs = path.split(delimiter).filter((dir) => dir.length > 0);
  const found: string[] = [];
  const missing: string[] = [];
  for (const command of commands) {
    (dirs.some((dir) => isExecutableFile(join(dir, command))) ? found : missing).push(command);
  }
  return { found, missing };
}
