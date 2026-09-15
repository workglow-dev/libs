/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IBrowserContext } from "@workglow/browser-control/task";

import type { BrowserContextFixture, IBrowserContextConformanceOpts } from "../types";

export function networkIntrospectionBlock(
  opts: IBrowserContextConformanceOpts,
  fixture: BrowserContextFixture
): void {
  if (!opts.capabilities.networkRequests && !opts.capabilities.consoleMessages) return;

  describe("Network/console introspection", () => {
    let ctx: IBrowserContext | undefined;
    let handle: Awaited<ReturnType<typeof opts.factory>> | undefined;

    beforeAll(async () => {
      handle = await opts.factory();
      ctx = await handle.create();
      await ctx.navigate(fixture.pageUrl);
      await ctx.waitForIdle({ timeout: 5_000 });
    }, opts.timeout);

    afterAll(async () => {
      if (handle && ctx) await handle.dispose(ctx);
    });

    if (opts.capabilities.networkRequests) {
      it(
        "networkRequests() captures the fixture's outbound fetch",
        async () => {
          if (!ctx || typeof ctx.networkRequests !== "function") {
            throw new Error("networkRequests not available despite capability=true");
          }
          const entries = await ctx.networkRequests();
          const found = entries.some((r) => r.url.includes(fixture.networkMarkerUrl));
          expect(found, `expected an entry containing ${fixture.networkMarkerUrl}`).toBe(true);
        },
        opts.timeout
      );

      it(
        "networkRequests({ method }) filters by method",
        async () => {
          if (!ctx || typeof ctx.networkRequests !== "function") {
            throw new Error("networkRequests not available despite capability=true");
          }
          const all = await ctx.networkRequests();
          const gets = await ctx.networkRequests({ method: "GET" });
          // Filter must not return more entries than the unfiltered list.
          expect(gets.length).toBeLessThanOrEqual(all.length);
        },
        opts.timeout
      );
    }

    if (opts.capabilities.consoleMessages) {
      it(
        "consoleMessages() captures the fixture's console.log",
        async () => {
          if (!ctx || typeof ctx.consoleMessages !== "function") {
            throw new Error("consoleMessages not available despite capability=true");
          }
          const entries = await ctx.consoleMessages();
          const found = entries.some((m) => m.text.includes(fixture.consoleMarker));
          expect(found, `expected a console message containing ${fixture.consoleMarker}`).toBe(
            true
          );
        },
        opts.timeout
      );
    }
  });
}
