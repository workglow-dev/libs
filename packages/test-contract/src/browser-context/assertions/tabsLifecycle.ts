/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IBrowserContext } from "@workglow/browser-control/task";

import type { BrowserContextFixture, IBrowserContextConformanceOpts } from "../types";
import { itExpectFail } from "./itExpectFail";

export function tabsLifecycleBlock(
  opts: IBrowserContextConformanceOpts,
  fixture: BrowserContextFixture
): void {
  describe("Tabs lifecycle", () => {
    const expectFail = (name: string) => opts.expectedFailures?.includes(name) ?? false;

    let ctx: IBrowserContext | undefined;
    let handle: Awaited<ReturnType<typeof opts.factory>> | undefined;

    beforeAll(async () => {
      handle = await opts.factory();
      ctx = await handle.create();
    }, opts.timeout);

    afterAll(async () => {
      if (handle && ctx) await handle.dispose(ctx);
    });

    // -- Basic lifecycle ----------------------------------------------------

    it(
      "tabs() returns at least one tab after connect",
      async () => {
        if (!ctx) throw new Error("context not created");
        const tabs = await ctx.tabs();
        expect(tabs.length).toBeGreaterThanOrEqual(1);
      },
      opts.timeout
    );

    if (opts.capabilities.multipleTabs) {
      it(
        "newTab() increases tab count by 1",
        async () => {
          if (!ctx) throw new Error("context not created");
          const before = (await ctx.tabs()).length;
          await ctx.newTab(fixture.pageUrl);
          const after = (await ctx.tabs()).length;
          expect(after).toBe(before + 1);
        },
        opts.timeout
      );
    }

    // -- Concurrent close stability ----------------------------------------

    if (opts.capabilities.multipleTabs) {
      const title = "tabId remains valid for surviving tabs across concurrent close()";
      const body = async () => {
        if (!ctx) throw new Error("context not created");
        // Set up four tabs with distinguishable urls.
        const urls = [
          "data:text/html,<title>A</title>",
          "data:text/html,<title>B</title>",
          "data:text/html,<title>C</title>",
          "data:text/html,<title>D</title>",
        ];
        // Reset to a known state by closing existing non-blank tabs.
        for (const t of await ctx.tabs()) {
          // best-effort cleanup; ignore failures
          try {
            await ctx.closeTab(t.tabId);
          } catch {
            /* noop */
          }
        }
        // Some backends require at least one tab; reconnect if needed.
        if ((await ctx.tabs()).length === 0) {
          await ctx.newTab(urls[0]);
        }
        // Ensure exactly four tabs in our known order.
        const baseTabs = await ctx.tabs();
        const opened: string[] = [];
        for (let i = 0; i < urls.length; i++) {
          if (i < baseTabs.length) {
            // navigate the existing one
            await ctx.switchTab(baseTabs[i].tabId);
            await ctx.navigate(urls[i]);
            opened.push(baseTabs[i].tabId);
          } else {
            const t = await ctx.newTab(urls[i]);
            opened.push(t.tabId);
          }
        }
        const [aId, bId, cId, dId] = opened;
        // Concurrent close.
        await Promise.all([ctx.closeTab(aId), ctx.closeTab(bId)]);
        // Surviving tabs C and D should still resolve to their original urls.
        await ctx.switchTab(cId);
        expect(await ctx.currentUrl()).toBe(urls[2]);
        await ctx.switchTab(dId);
        expect(await ctx.currentUrl()).toBe(urls[3]);
      };
      if (expectFail("tabs.concurrentCloseStable")) {
        itExpectFail(title, body, opts.timeout);
      } else {
        it(title, body, opts.timeout);
      }
    } else {
      // Single-view backends: closeTab(only tabId) must either disconnect
      // OR leave a single tab — accept either result, just don't crash.
      it(
        "single-view: closeTab on the sole tab disconnects or no-ops",
        async () => {
          if (!ctx) throw new Error("context not created");
          const [t] = await ctx.tabs();
          try {
            await ctx.closeTab(t.tabId);
          } catch {
            /* some single-view backends may throw — that is acceptable */
          }
          // Either disconnected or still has at most one tab.
          if (ctx.isConnected()) {
            const after = await ctx.tabs();
            expect(after.length).toBeLessThanOrEqual(1);
          }
        },
        opts.timeout
      );
    }
  });
}
