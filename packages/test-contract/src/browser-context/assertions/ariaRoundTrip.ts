/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AccessibilityNode, IBrowserContext } from "@workglow/browser-control/task";

import type { BrowserContextFixture, IBrowserContextConformanceOpts } from "../types";
import { itExpectFail } from "./itExpectFail";

function collectButtons(root: AccessibilityNode): AccessibilityNode[] {
  const out: AccessibilityNode[] = [];
  const stack: AccessibilityNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.role === "button") out.push(n);
    if (n.children) stack.push(...n.children);
  }
  return out;
}

export function ariaRoundTripBlock(
  opts: IBrowserContextConformanceOpts,
  fixture: BrowserContextFixture
): void {
  if (!opts.capabilities.ariaSnapshot) return;

  describe("ARIA round-trip", () => {
    const expectFail = (name: string) => opts.expectedFailures?.includes(name) ?? false;

    let ctx: IBrowserContext | undefined;
    let handle: Awaited<ReturnType<typeof opts.factory>> | undefined;

    beforeAll(async () => {
      handle = await opts.factory();
      ctx = await handle.create();
      // Navigate once; all assertions reuse this page.
      await ctx.navigate(fixture.pageUrl);
      await ctx.waitForIdle({ timeout: 5_000 });
    }, opts.timeout);

    afterAll(async () => {
      if (handle && ctx) await handle.dispose(ctx);
    });

    // -- Round-trip per edge-case name -------------------------------------

    for (let i = 0; i < fixture.ariaEdgeCaseNames.length; i++) {
      const name = fixture.ariaEdgeCaseNames[i];
      const isColonName = name.includes(":");
      const title = `clickByRole('button', ${JSON.stringify(name)}) lands on the right node`;
      const body = async () => {
        if (!ctx) throw new Error("context not created");
        const tree = await ctx.snapshot();
        const buttons = collectButtons(tree.root);
        const target = buttons.find((b) => b.name === name);
        expect(
          target,
          `snapshot must include button with name ${JSON.stringify(name)}`
        ).toBeDefined();

        await ctx.clickByRole("button", name);

        // Read `data-clicked` from the sentinel element.
        const sentinelRef = await ctx.querySelector("#sentinel");
        expect(sentinelRef).not.toBeNull();
        const clicked = await ctx.attribute(sentinelRef!, "data-clicked");
        expect(clicked).toBe(String(i));
      };
      // Names containing a colon trigger the lastIndexOf parser bug in
      // PlaywrightBackend. Adapters with that bug list "aria.colonInName"
      // in expectedFailures; the helper wraps in `it.fails` for them.
      const useExpectFail = isColonName && expectFail("aria.colonInName");
      if (useExpectFail) {
        itExpectFail(title, body, opts.timeout);
      } else {
        it(title, body, opts.timeout);
      }
    }

    // -- Ref reuse after a second snapshot ---------------------------------

    it(
      "refs from snapshot N remain usable for textContent after snapshot N+1",
      async () => {
        if (!ctx) throw new Error("context not created");
        const t1 = await ctx.snapshot();
        const buttons1 = collectButtons(t1.root);
        expect(buttons1.length).toBeGreaterThan(0);
        const ref = buttons1[0].ref;
        // Take a fresh snapshot, then reach back to the older ref.
        await ctx.snapshot();
        const txt = await ctx.textContent(ref);
        expect(txt, "ref from prior snapshot should still resolve").not.toBeNull();
      },
      opts.timeout
    );
  });
}
