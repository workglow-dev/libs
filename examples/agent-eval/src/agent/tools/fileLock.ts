/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const tails = new Map<string, Promise<void>>();

/** The file a path names, so a symlink and its target share one lock. */
async function lockKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Not there yet (a write creating it): the file it will be, in its real directory.
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * Runs `work` once every earlier holder of `path` has finished. With
 * `toolConcurrency` above one, two edits of one file would otherwise both read
 * it, each apply its own change, and the later write would silently drop the
 * other's.
 */
export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = await lockKey(path);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
  tails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
