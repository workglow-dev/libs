/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage, TabularChangePayload } from "@workglow/storage";
import { sleep } from "@workglow/util";
import type { FromSchema } from "@workglow/util/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

/**
 * Subscription contract. Selection between the two blocks below is driven by
 * `opts.usesPolling`:
 *
 *   - `usesPolling: false` → `subscribeToChanges.eventDriven` — strict commit
 *     order (event-driven subscriptions like Postgres LISTEN/NOTIFY or the
 *     in-memory broadcast bus emit one event per write, in write order).
 *   - `usesPolling: true`  → `subscribeToChanges.polling` — set equality plus
 *     event count (polling-based subscriptions diff a snapshot and have no
 *     way to preserve commit order).
 *
 * When `capabilities.supportsSubscriptions` is true, `usesPolling` is
 * required on the contract opts; the type guarantees this at compile time.
 */
export function subscribeToChangesBlock(opts: TabularStorageContractOpts): void {
  if (!opts.capabilities.supportsSubscriptions) {
    describe.skip("subscribeToChanges", () => {
      it("skipped: capabilities.supportsSubscriptions === false", () => {});
    });
    return;
  }

  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("subscribeToChanges") ? itExpectFail : it;
  // `usesPolling` is required when `supportsSubscriptions: true` (enforced by
  // the discriminated `TabularStorageContractOpts` union). The non-null
  // assertion below is safe given the early-return on `supportsSubscriptions`.
  const usesPolling = opts.usesPolling!;
  const pollingIntervalMs = opts.pollingIntervalMs ?? 1;
  const waitTime = usesPolling ? Math.max(pollingIntervalMs * 8, 200) : 50;
  const initWaitTime = usesPolling ? Math.max(pollingIntervalMs * 10, 300) : 10;

  if (usesPolling) {
    describe("subscribeToChanges.polling", () => {
      let storage: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

      beforeEach(async () => {
        storage = await opts.createStorage();
        await storage.setupDatabase?.();
      });

      afterEach(async () => {
        await storage.deleteAll();
        storage.destroy?.();
        await opts.releaseStorage?.(storage);
      });

      itImpl(
        "observes every write (set equality + count, order unspecified)",
        async () => {
          const changes: TabularChangePayload<FromSchema<typeof CompoundSchema>>[] = [];
          const unsubscribe = storage.subscribeToChanges((change) => changes.push(change), {
            pollingIntervalMs,
          });

          await sleep(initWaitTime);

          await storage.put({ name: "t1", type: "s1", option: "v1", success: true });
          await storage.put({ name: "t2", type: "s2", option: "v2", success: false });
          await storage.put({ name: "t3", type: "s3", option: "v3", success: true });

          await sleep(waitTime);

          const writeEvents = changes.filter((c) => c.type === "INSERT" || c.type === "UPDATE");
          // Polling diffs a snapshot: every write must be visible exactly once,
          // but commit order is unspecified.
          expect(writeEvents.length).toBe(3);
          const options = writeEvents
            .map((e) => e.new?.option)
            .sort((a, b) => String(a).localeCompare(String(b)));
          expect(options).toEqual(["v1", "v2", "v3"]);

          unsubscribe();
        },
        opts.timeout
      );
    });
    return;
  }

  describe("subscribeToChanges.eventDriven", () => {
    let storage: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(async () => {
      storage = await opts.createStorage();
      await storage.setupDatabase?.();
    });

    afterEach(async () => {
      await storage.deleteAll();
      storage.destroy?.();
      await opts.releaseStorage?.(storage);
    });

    itImpl(
      "fires exactly once per write in commit order",
      async () => {
        const changes: TabularChangePayload<FromSchema<typeof CompoundSchema>>[] = [];
        const unsubscribe = storage.subscribeToChanges((change) => changes.push(change), {
          pollingIntervalMs,
        });

        await sleep(initWaitTime);

        await storage.put({ name: "t1", type: "s1", option: "v1", success: true });
        await storage.put({ name: "t2", type: "s2", option: "v2", success: false });
        await storage.put({ name: "t3", type: "s3", option: "v3", success: true });

        await sleep(waitTime);

        const writeEvents = changes.filter((c) => c.type === "INSERT" || c.type === "UPDATE");
        // Event-driven backends must emit one event per write in commit order.
        expect(writeEvents.length).toBe(3);
        expect(writeEvents[0].new?.option).toBe("v1");
        expect(writeEvents[1].new?.option).toBe("v2");
        expect(writeEvents[2].new?.option).toBe("v3");

        unsubscribe();
      },
      opts.timeout
    );
  });
}
