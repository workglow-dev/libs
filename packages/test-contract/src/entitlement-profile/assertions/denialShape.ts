/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { UNCOVERED_FOO } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * The denial returned by requestEntitlement for an uncovered entitlement
 * must satisfy the EntitlementDenial discriminated union: a `reason` of
 * "policy-deny" / "user-deny" requires `matchedRule`; "default-deny"
 * forbids it.
 */
export function denialShapeBlock(
  _opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe("Denial shape", () => {
    it("denial.entitlement is reference-equal to the requested entitlement", async () => {
      const profile = getHandle().profile;
      const result = await profile.requestEntitlement(UNCOVERED_FOO);
      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.denial.entitlement).toBe(UNCOVERED_FOO);
      }
    });

    it("denial.reason matches the EntitlementDenialReason union", async () => {
      const profile = getHandle().profile;
      const result = await profile.requestEntitlement(UNCOVERED_FOO);
      if (result.outcome === "denied") {
        expect(["policy-deny", "default-deny", "user-deny"]).toContain(result.denial.reason);
      }
    });

    it("policy-deny and user-deny carry matchedRule; default-deny does not", async () => {
      const profile = getHandle().profile;
      const result = await profile.requestEntitlement(UNCOVERED_FOO);
      if (result.outcome === "denied") {
        const d = result.denial;
        if (d.reason === "default-deny") {
          // Discriminated union: default-deny variant has no matchedRule property.
          expect("matchedRule" in d).toBe(false);
        } else {
          // policy-deny / user-deny carry matchedRule.
          expect(d.matchedRule).toBeDefined();
        }
      }
    });
  });
}
