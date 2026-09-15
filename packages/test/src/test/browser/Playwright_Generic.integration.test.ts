/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runIBrowserContextConformance } from "@workglow/test-contract/browser-context";

let playwrightAvailable = false;
try {
  await import("playwright");
  playwrightAvailable = true;
} catch {
  // playwright not installed
}

runIBrowserContextConformance({
  name: "Playwright",
  skip: !playwrightAvailable,
  timeout: 60_000,
  factory: async () => {
    const { PlaywrightBackend } = await import("@workglow/playwright");
    return {
      create: async () => {
        const ctx = new PlaywrightBackend();
        await ctx.connect({ headless: true });
        return ctx;
      },
      dispose: async (ctx) => {
        await ctx.disconnect();
      },
    };
  },
  capabilities: {
    multipleTabs: true,
    networkRequests: false,
    consoleMessages: false,
    ariaSnapshot: true,
  },
  expectedFailures: [],
});
