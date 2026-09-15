/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runIBrowserContextConformance } from "@workglow/test-contract/browser-context";

const RUN_ELECTRON = !!process.env.RUN_ELECTRON_TESTS;

runIBrowserContextConformance({
  name: "Electron",
  skip: !RUN_ELECTRON,
  timeout: 60_000,
  factory: async () => {
    const { ElectronBackend } = await import("@workglow/electron");
    return {
      create: async () => {
        const ctx = new ElectronBackend();
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
