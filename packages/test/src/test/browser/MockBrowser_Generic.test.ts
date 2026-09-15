/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConformanceMockContext } from "@workglow/test-contract/browser-context";
import { runIBrowserContextConformance } from "@workglow/test-contract/browser-context";

runIBrowserContextConformance({
  name: "Mock",
  timeout: 5_000,
  factory: async () => ({
    create: async () => {
      const ctx = new ConformanceMockContext();
      await ctx.connect();
      return ctx;
    },
    dispose: async (ctx) => ctx.disconnect(),
  }),
  capabilities: {
    multipleTabs: true,
    networkRequests: false,
    consoleMessages: false,
    ariaSnapshot: true,
  },
});
