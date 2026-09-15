/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import type { EntitlementChangeEvent } from "@workglow/task-graph";
import { NETWORK_HTTP_REQUIRED, UNCOVERED_FOO } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * After querying a set of entitlements then signalling reload, change events
 * fire only for entitlements whose verdict actually flipped.
 */
export function subscribeReloadBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.mutableSignalSource)("Subscribe reload", () => {
    it("reload fires events only for previously-queried entitlements that flipped", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) return;
      const events: EntitlementChangeEvent[] = [];
      // Pre-seed by querying two entitlements before subscribing.
      await handle.profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
      await handle.profile.requestEntitlement(UNCOVERED_FOO);
      const unsub = handle.profile.subscribe((e) => events.push(e));
      try {
        // The shim's simulateSignal stages a policy mutation that flips
        // exactly one of the two seeded entitlements before emitting reload.
        handle.simulateSignal({ kind: "reload" });
        await new Promise((r) => setTimeout(r, 0));
        // The shim's simulateSignal stages a policy mutation that flips exactly
        // one of the two seeded entitlements (NETWORK_HTTP) before emitting reload.
        // A conforming profile emits change events ONLY for entitlements that
        // actually flipped — never for entitlements whose verdict is unchanged.
        expect(events.map((e) => e.entitlement.id)).toEqual([NETWORK_HTTP_REQUIRED.id]);
      } finally {
        unsub();
      }
    });
  });
}
