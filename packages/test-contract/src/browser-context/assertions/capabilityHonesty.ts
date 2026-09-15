/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BrowserContextFixture, IBrowserContextConformanceOpts } from "../types";
import { itExpectFail } from "./itExpectFail";

export function capabilityHonestyBlock(
  opts: IBrowserContextConformanceOpts,
  fixture: BrowserContextFixture
): void {
  describe("Capability honesty", () => {
    const expectFail = (name: string) => opts.expectedFailures?.includes(name) ?? false;

    let ctx: import("@workglow/browser-control/task").IBrowserContext | undefined;
    let handle: Awaited<ReturnType<typeof opts.factory>> | undefined;

    beforeAll(async () => {
      handle = await opts.factory();
      ctx = await handle.create();
    }, opts.timeout);

    afterAll(async () => {
      if (handle && ctx) await handle.dispose(ctx);
    });

    // -- Negative direction -------------------------------------------------

    const runNegative = (
      methodName: "networkRequests" | "consoleMessages",
      assertionName: string
    ) => {
      const body = async () => {
        if (!ctx) throw new Error("context not created");
        // The contract says: when the capability is false, the method must
        // be strictly undefined — NOT a no-op stub returning [].
        expect(typeof (ctx as unknown as Record<string, unknown>)[methodName]).toBe("undefined");
      };
      const title = `declares ${methodName}=false → ctx.${methodName} is undefined`;
      if (expectFail(assertionName)) {
        itExpectFail(title, body, opts.timeout);
      } else {
        it(title, body, opts.timeout);
      }
    };

    if (!opts.capabilities.networkRequests) {
      runNegative("networkRequests", "capability.networkRequests.undefinedWhenFalse");
    }
    if (!opts.capabilities.consoleMessages) {
      runNegative("consoleMessages", "capability.consoleMessages.undefinedWhenFalse");
    }

    // -- Positive direction -------------------------------------------------

    if (opts.capabilities.networkRequests) {
      it(
        "declares networkRequests=true → fixture fetch is observable",
        async () => {
          if (!ctx) throw new Error("context not created");
          if (typeof ctx.networkRequests !== "function") {
            throw new Error(
              "capability claims networkRequests=true but ctx.networkRequests is not a function"
            );
          }
          await ctx.navigate(fixture.pageUrl);
          await ctx.waitForIdle({ timeout: 5_000 });
          const entries = await ctx.networkRequests();
          const found = entries.some((r) => r.url.includes(fixture.networkMarkerUrl));
          expect(found, `expected an entry containing ${fixture.networkMarkerUrl}`).toBe(true);
        },
        opts.timeout
      );
    }

    if (opts.capabilities.consoleMessages) {
      it(
        "declares consoleMessages=true → fixture console.log is observable",
        async () => {
          if (!ctx) throw new Error("context not created");
          if (typeof ctx.consoleMessages !== "function") {
            throw new Error(
              "capability claims consoleMessages=true but ctx.consoleMessages is not a function"
            );
          }
          await ctx.navigate(fixture.pageUrl);
          await ctx.waitForIdle({ timeout: 5_000 });
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
