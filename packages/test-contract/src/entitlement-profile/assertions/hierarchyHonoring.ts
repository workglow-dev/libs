/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * If the profile surface includes a parent entitlement (e.g. "network"),
 * requesting a child entitlement (e.g. "network:http") must be granted.
 */
export function hierarchyHonoringBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.hierarchyHonoring)("Hierarchy honoring", () => {
    it("granting a parent ID covers child IDs in the namespace", async () => {
      const profile = getHandle().profile;
      // Find a grant whose ID has no colon (a parent), then probe a child.
      const parentGrant = profile.surface().find((g) => !g.id.includes(":") && !g.resources);
      if (!parentGrant) {
        // No broad parent grant in this profile; assertion vacuous.
        return;
      }
      const childId = `${parentGrant.id}:probe`;
      const result = await profile.requestEntitlement({ id: childId });
      expect(result.outcome).toBe("granted");
    });
  });
}
