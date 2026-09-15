/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test preload that decrypts the on-disk credential store (if a passphrase is
 * available) and hydrates `process.env` for the providers that read API keys
 * from the environment. Referenced by both `vitest.setup.ts` and
 * `bunfig.toml`'s `[test].preload` list.
 *
 * Both of those run once per TEST FILE, and a test file is a fresh process, so
 * this is where the cost of decrypting eight credentials was multiplied by the
 * size of the suite. It is cheap now only because something earlier in the
 * process tree normally did the work already and this finds nothing left to do
 * — `vitest.globalSetup.ts` for vitest, `scripts/test.ts` before it spawns
 * either runner. Neither is a precondition: run a single file directly and
 * this still hydrates it, which is why it stays wired here.
 *
 * Without a passphrase it is a no-op and integration tests skip through their
 * existing `!!process.env.*_API_KEY` guards.
 */

import { hydrateTestCredentials } from "./test-credentials";

await hydrateTestCredentials();
