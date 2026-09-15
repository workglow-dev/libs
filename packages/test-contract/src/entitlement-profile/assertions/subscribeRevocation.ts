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
 * Verify that the profile re-evaluates and emits a "revoked" change event
 * when the signal source emits a revoke for a previously-granted
 * entitlement, and emits nothing when no flip occurred.
 */
export function subscribeRevocationBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.mutableSignalSource)("Subscribe revocation", () => {
    it("emits revoked when previously-granted entitlement becomes denied", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) {
        throw new Error("simulateSignal must be present when mutableSignalSource is true");
      }
      const events: EntitlementChangeEvent[] = [];
      const unsub = handle.profile.subscribe((e) => events.push(e));
      try {
        // Seed: query and confirm currently granted.
        const before = await handle.profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
        if (before.outcome !== "granted") {
          // Profile does not grant this; this assertion is vacuous for it.
          return;
        }
        // The Custom_Profile shim's underlying policy mutates so that revoke
        // signals reflect a real flip; the simulateSignal hook on the shim
        // is responsible for staging that policy change before emitting.
        handle.simulateSignal({ kind: "revoke", entitlement: NETWORK_HTTP_REQUIRED });
        await new Promise((r) => setTimeout(r, 0));
        const revoked = events.find((e) => e.kind === "revoked");
        expect(revoked).toBeDefined();
        expect(revoked?.entitlement.id).toBe(NETWORK_HTTP_REQUIRED.id);
      } finally {
        unsub();
      }
    });

    it("does not emit when no flip occurs (revoke for never-granted entitlement)", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) return;
      const events: EntitlementChangeEvent[] = [];
      const unsub = handle.profile.subscribe((e) => events.push(e));
      try {
        // Query an uncovered entitlement: it's already denied.
        await handle.profile.requestEntitlement(UNCOVERED_FOO);
        handle.simulateSignal({ kind: "revoke", entitlement: UNCOVERED_FOO });
        await new Promise((r) => setTimeout(r, 0));
        expect(events).toEqual([]);
      } finally {
        unsub();
      }
    });
  });
}
