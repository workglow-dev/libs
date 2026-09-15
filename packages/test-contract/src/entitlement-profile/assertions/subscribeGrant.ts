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
 * Verify that the profile emits a "granted" change event when the signal
 * source emits a grant for a previously-denied entitlement.
 */
export function subscribeGrantBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.mutableSignalSource)("Subscribe grant", () => {
    it("emits granted when previously-denied entitlement becomes granted", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) {
        throw new Error("simulateSignal must be present when mutableSignalSource is true");
      }
      const events: EntitlementChangeEvent[] = [];
      const unsub = handle.profile.subscribe((e) => events.push(e));
      try {
        // Seed: query an entitlement that is currently denied. The Custom shim's
        // simulateSignal stages the policy flip before emitting the signal.
        const before = await handle.profile.requestEntitlement(UNCOVERED_FOO);
        if (before.outcome !== "denied") return; // not the case for this profile
        handle.simulateSignal({ kind: "grant", entitlement: UNCOVERED_FOO });
        await new Promise((r) => setTimeout(r, 0));
        const granted = events.find((e) => e.kind === "granted");
        expect(granted).toBeDefined();
        expect(granted?.entitlement.id).toBe(UNCOVERED_FOO.id);
      } finally {
        unsub();
      }
    });

    it("does not emit when grant signal arrives for already-granted entitlement", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) return;
      const events: EntitlementChangeEvent[] = [];
      const unsub = handle.profile.subscribe((e) => events.push(e));
      try {
        // Seed: query an entitlement currently granted by the policy.
        const before = await handle.profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
        if (before.outcome !== "granted") return; // not the case for this profile
        handle.simulateSignal({ kind: "grant", entitlement: NETWORK_HTTP_REQUIRED });
        await new Promise((r) => setTimeout(r, 0));
        expect(events).toEqual([]);
      } finally {
        unsub();
      }
    });
  });
}
