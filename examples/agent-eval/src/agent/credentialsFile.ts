/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, unlinkSync } from "node:fs";

/**
 * Moves the variables in a JSON file into `env` and deletes the file, returning
 * the names it set.
 *
 * This is how the Harbor adapter hands the agent its API keys. A process's
 * starting environment stays readable at `/proc/<pid>/environ` for its whole
 * life, and every command the model runs through `bash` is a descendant of the
 * agent, so a key passed in the environment of the command that starts it can be
 * read back by the model however the shell's own environment is filtered.
 * Variables set after start are not in that file. The file is deleted before any
 * tool can run, and a file that cannot be deleted stops the run: left in place,
 * the keys would be one `cat` away.
 */
export function loadCredentialsFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const text = readFileSync(path, "utf8");
  // Deleted before it is parsed, so a malformed file does not outlive the run either.
  try {
    unlinkSync(path);
  } catch (error) {
    throw new Error(
      `could not delete the credentials file ${path} after reading it: ${(error as Error).message}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the credentials file ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`the credentials file ${path} is not a JSON object`);
  }
  const names: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`the credentials file ${path} has a non-string value for ${name}`);
    }
    env[name] = value;
    names.push(name);
  }
  return names;
}
