/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { InMemoryTabularStorage } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

type CompoundStorage = ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

/**
 * Which path a join takes. A backend that can share a connection handle must
 * run a same-handle join as one statement — proven by the right side's `query`
 * never being called — and must fall back to the hash join, which does call
 * it, when the right side lives elsewhere.
 */
export function joinPushdownBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("joinPushdown") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsQuery || !opts.createSiblingStorage)(
    "joinPushdown",
    () => {
      let primary: CompoundStorage;
      let sibling: CompoundStorage;

      beforeEach(async () => {
        primary = await opts.createStorage();
        await primary.setupDatabase?.();
        sibling = await opts.createSiblingStorage!(primary);
        await sibling.setupDatabase?.();
        await primary.putBulk([
          { name: "a", type: "t", option: "x", success: true },
          { name: "b", type: "t", option: "y", success: false },
        ]);
        await sibling.putBulk([
          { name: "a", type: "u", option: "p", success: true },
          { name: "c", type: "u", option: "q", success: true },
        ]);
      });

      afterEach(async () => {
        await primary.deleteAll();
        await sibling.deleteAll();
        primary.destroy?.();
        sibling.destroy?.();
        await opts.releaseStorage?.(primary);
        await opts.releaseStorage?.(sibling);
        vi.restoreAllMocks();
      });

      itImpl(
        "runs a same-connection join without querying the right side",
        async () => {
          const rightQuery = vi.spyOn(sibling, "query");
          const rows = await primary.join(
            {
              type: "left",
              on: [{ left: "name", right: "name" }],
              orderBy: [{ side: "left", column: "name", direction: "ASC" }],
            },
            sibling
          );
          expect(rightQuery).not.toHaveBeenCalled();
          expect(rows.map((r) => `${r.left.name}:${r.right?.type ?? "-"}`)).toEqual(["a:u", "b:-"]);
        },
        opts.timeout
      );

      itImpl(
        "falls back to the hash join for a right side on another connection",
        async () => {
          const elsewhere = new InMemoryTabularStorage<
            typeof CompoundSchema,
            typeof CompoundPrimaryKeyNames
          >(CompoundSchema, CompoundPrimaryKeyNames);
          await elsewhere.putBulk([{ name: "b", type: "v", option: "z", success: true }]);
          const rightQuery = vi.spyOn(elsewhere, "query");
          const rows = await primary.join(
            {
              type: "left",
              on: [{ left: "name", right: "name" }],
              orderBy: [{ side: "left", column: "name", direction: "ASC" }],
            },
            elsewhere
          );
          expect(rightQuery).toHaveBeenCalled();
          expect(rows.map((r) => `${r.left.name}:${r.right?.type ?? "-"}`)).toEqual(["a:-", "b:v"]);
        },
        opts.timeout
      );
    }
  );
}
