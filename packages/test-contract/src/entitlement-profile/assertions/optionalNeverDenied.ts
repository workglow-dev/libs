/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { OPTIONAL_CREDENTIAL } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * Optional entitlements must never be reported as denied — neither by
 * `requestEntitlement` nor by `checkAll`.
 */
export function optionalNeverDeniedBlock(
  _opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe("Optional entitlements never denied", () => {
    it("requestEntitlement returns granted for an optional entitlement", async () => {
      const profile = getHandle().profile;
      const result = await profile.requestEntitlement(OPTIONAL_CREDENTIAL);
      expect(result.outcome).toBe("granted");
    });

    it("checkAll returns no denials for an optional entitlement even when uncovered", async () => {
      const profile = getHandle().profile;
      const denials = await profile.checkAll({
        entitlements: [{ id: "uncovered:optional", optional: true }],
      });
      expect(denials).toEqual([]);
    });
  });
}
