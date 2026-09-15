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

export function surfaceCoverageBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe("Surface coverage", () => {
    it("surface() includes every entitlement listed in expected.surfaceIncludes", async () => {
      const profile = getHandle().profile;
      const surface = profile.surface().map((g) => g.id);
      for (const id of opts.expected.surfaceIncludes) {
        expect(surface).toContain(id);
      }
    });

    it("surface() excludes every entitlement listed in expected.surfaceExcludes", async () => {
      const profile = getHandle().profile;
      const surface = profile.surface().map((g) => g.id);
      for (const id of opts.expected.surfaceExcludes) {
        expect(surface).not.toContain(id);
      }
    });

    it("requestEntitlement returns granted for an entitlement covered by surface", async () => {
      const profile = getHandle().profile;
      const firstGrant = profile.surface()[0];
      if (!firstGrant) {
        // empty surface — assertion vacuous; opts.expected.surfaceIncludes
        // would have been empty too.
        return;
      }
      const result = await profile.requestEntitlement({ id: firstGrant.id });
      expect(result.outcome).toBe("granted");
    });

    it("requestEntitlement returns denied with default-deny reason for an uncovered entitlement", async () => {
      const profile = getHandle().profile;
      const result = await profile.requestEntitlement(UNCOVERED_FOO);
      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.denial.reason).toBe("default-deny");
        expect(result.denial.entitlement).toBe(UNCOVERED_FOO);
      }
    });
  });
}
