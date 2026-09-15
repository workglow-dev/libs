/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runIBrowserContextConformance } from "@workglow/test-contract/browser-context";
import { isChromeAvailable } from "./chromeAvailability";

const bunWebViewAvailable =
  Boolean((globalThis as { Bun?: { WebView?: unknown } }).Bun?.WebView) && isChromeAvailable();

runIBrowserContextConformance({
  name: "BunWebView",
  skip: !bunWebViewAvailable,
  timeout: 60_000,
  factory: async () => {
    const { BunWebViewBackend } = await import("@workglow/bun-webview");
    return {
      create: async () => {
        const ctx = new BunWebViewBackend();
        await ctx.connect({ headless: true });
        return ctx;
      },
      dispose: async (ctx) => {
        await ctx.disconnect();
      },
    };
  },
  capabilities: {
    multipleTabs: false, // single-view model
    networkRequests: false,
    consoleMessages: false,
    ariaSnapshot: true,
  },
  expectedFailures: [],
});
