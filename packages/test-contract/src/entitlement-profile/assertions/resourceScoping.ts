/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { SCOPED_FILESYSTEM_ETC_BAD, SCOPED_FILESYSTEM_TMP_OK } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * For a profile that supports resource scoping, build a temporary scoped
 * grant by augmenting the profile is out of scope here — instead we
 * exercise the policy with a known-scoped fixture only when the profile
 * already grants filesystem broadly. When `filesystem` is broadly granted,
 * a scoped read of any resource succeeds. This block additionally verifies
 * that profiles which DO NOT grant filesystem deny a scoped read of
 * `/etc/passwd`.
 */
export function resourceScopingBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.resourceScoping)("Resource scoping", () => {
    it("scoped read succeeds when the profile broadly grants filesystem", async () => {
      const profile = getHandle().profile;
      const hasBroadFilesystem = profile
        .surface()
        .some((g) => g.id === "filesystem" && !g.resources);
      if (!hasBroadFilesystem) {
        // Profile does not broadly grant filesystem; this assertion is vacuous.
        return;
      }
      const result = await profile.requestEntitlement(SCOPED_FILESYSTEM_TMP_OK);
      expect(result.outcome).toBe("granted");
    });

    it("scoped read fails when the profile does not grant filesystem at all", async () => {
      const profile = getHandle().profile;
      const hasFilesystem = profile
        .surface()
        .some((g) => g.id === "filesystem" || g.id === "filesystem:read");
      if (hasFilesystem) {
        return; // not the negative case
      }
      const result = await profile.requestEntitlement(SCOPED_FILESYSTEM_ETC_BAD);
      expect(result.outcome).toBe("denied");
    });
  });
}
