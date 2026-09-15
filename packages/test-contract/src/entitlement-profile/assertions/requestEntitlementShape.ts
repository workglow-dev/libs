/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { NETWORK_HTTP_REQUIRED, UNCOVERED_FOO } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * For the same input, `requestEntitlement` and `checkAll([input])` agree:
 * - granted ↔ empty denial array
 * - denied ↔ single-element denial array with matching reason
 */
export function requestEntitlementShapeBlock(
  _opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe("requestEntitlement shape parity with checkAll", () => {
    it("granted: requestEntitlement and checkAll agree", async () => {
      const profile = getHandle().profile;
      const isCovered = profile
        .surface()
        .some((g) => g.id === NETWORK_HTTP_REQUIRED.id && !g.resources);
      if (!isCovered) return; // assertion vacuous if profile doesn't grant network:http
      const single = await profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
      const all = await profile.checkAll({ entitlements: [NETWORK_HTTP_REQUIRED] });
      expect(single.outcome).toBe("granted");
      expect(all).toEqual([]);
    });

    it("denied: requestEntitlement and checkAll agree on reason", async () => {
      const profile = getHandle().profile;
      const single = await profile.requestEntitlement(UNCOVERED_FOO);
      const all = await profile.checkAll({ entitlements: [UNCOVERED_FOO] });
      expect(single.outcome).toBe("denied");
      expect(all).toHaveLength(1);
      if (single.outcome === "denied") {
        expect(all[0]!.reason).toBe(single.denial.reason);
        // Spec parity: when reason is policy-deny / user-deny, both calls must
        // return the same matchedRule. default-deny carries no matchedRule.
        if (single.denial.reason !== "default-deny") {
          expect((all[0]! as { matchedRule?: unknown }).matchedRule).toEqual(
            (single.denial as { matchedRule?: unknown }).matchedRule
          );
        }
      }
    });
  });
}
