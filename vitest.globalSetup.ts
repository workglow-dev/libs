/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decrypt the test credential store ONCE per vitest run.
 *
 * `vitest.setup.ts` runs per test file, and a test file is a fresh process, so
 * hydrating there meant decrypting eight credentials ~700 times for one unit
 * run — nine 600k-iteration PBKDF2 derivations apiece, which measured as 53%
 * of the slice's wall clock. Global setup runs in the main process before any
 * worker is spawned, and a worker inherits `process.env`, so one hydrate here
 * serves every file: the per-file preload then finds every value already in
 * the environment and returns without deriving anything.
 *
 * It stays in the per-file preload as well rather than moving here outright,
 * because `bun test` has no global-setup hook and a single file run directly
 * still has to get its keys from somewhere.
 */

import { hydrateTestCredentials } from "./scripts/lib/test-credentials";

export default async function setup(): Promise<void> {
  await hydrateTestCredentials();
}
