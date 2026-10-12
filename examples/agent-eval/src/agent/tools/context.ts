/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute, resolve } from "node:path";

/** What every coding tool is bound to. */
export interface CodingToolContext {
  /** Directory relative paths and commands resolve against. */
  readonly cwd: string;
  /** Directory a command's full output is spilled to when the model sees only its tail. */
  readonly spillDir: string;
  /** Seconds a command may run when the model does not say. */
  readonly defaultCommandTimeoutSec: number;
  /** Whether `read` returns images to the model, or refuses them as binary. */
  readonly images: boolean;
}

/**
 * Where a path the model wrote points. Absolute paths are honoured: benchmark
 * instructions routinely name `/app/…`, and the sandbox is the container, not
 * the working directory.
 */
export function resolvePath(context: CodingToolContext, path: string): string {
  const trimmed = path.trim();
  const expanded = trimmed.startsWith("~/")
    ? `${process.env.HOME ?? "/root"}${trimmed.slice(1)}`
    : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded);
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  return value;
}

export function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return Math.trunc(n);
}
