/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import type { EntitlementChangeEvent } from "@workglow/task-graph";
import { NETWORK_HTTP_REQUIRED } from "../fixtures";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "../types";

/**
 * dispose() is idempotent. After dispose, a simulateSignal does not deliver
 * events to listeners that subscribed before dispose.
 *
 * NOTE: This block uses an isolated profile via the factory, not the shared
 * conformance handle, because disposing the shared handle would break later
 * blocks. The factory is invoked again here; afterAll on the shared handle
 * still runs against its own profile.
 */
export function disposeBlock(
  opts: EntitlementProfileConformanceOpts,
  _getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe("Dispose", () => {
    it("dispose is idempotent (two calls succeed)", async () => {
      const local = await opts.factory();
      try {
        await local.profile.dispose();
        await expect(local.profile.dispose()).resolves.toBeUndefined();
      } finally {
        // local.dispose() is itself idempotent and will exercise dispose() again.
        await local.dispose();
      }
    });

    it.skipIf(!opts.capabilities.mutableSignalSource)(
      "after dispose, signal source no longer drives events",
      async () => {
        const local = await opts.factory();
        try {
          if (!local.simulateSignal) return;
          const events: EntitlementChangeEvent[] = [];
          local.profile.subscribe((e) => events.push(e));
          await local.profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
          await local.profile.dispose();
          local.simulateSignal({ kind: "revoke", entitlement: NETWORK_HTTP_REQUIRED });
          await new Promise((r) => setTimeout(r, 0));
          expect(events).toEqual([]);
        } finally {
          await local.dispose();
        }
      }
    );
  });
}
