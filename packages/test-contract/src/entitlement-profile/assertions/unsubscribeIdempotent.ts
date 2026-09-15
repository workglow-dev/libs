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

export function unsubscribeIdempotentBlock(
  opts: EntitlementProfileConformanceOpts,
  getHandle: () => EntitlementProfileConformanceHandle
): void {
  describe.skipIf(!opts.capabilities.mutableSignalSource)("Unsubscribe idempotent", () => {
    it("calling unsubscribe twice does not throw", () => {
      const profile = getHandle().profile;
      const unsub = profile.subscribe(() => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("after unsubscribe, no further events are delivered", async () => {
      const handle = getHandle();
      if (!handle.simulateSignal) return;
      const events: EntitlementChangeEvent[] = [];
      const unsub = handle.profile.subscribe((e) => events.push(e));
      // Seed and unsub before signalling.
      await handle.profile.requestEntitlement(NETWORK_HTTP_REQUIRED);
      unsub();
      handle.simulateSignal({ kind: "revoke", entitlement: NETWORK_HTTP_REQUIRED });
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual([]);
    });
  });
}
