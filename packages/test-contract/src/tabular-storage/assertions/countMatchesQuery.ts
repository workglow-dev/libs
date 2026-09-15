/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

export function countMatchesQueryBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("countMatchesQuery") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsQuery)("countMatchesQuery", () => {
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
      "count(predicate) equals query(predicate).length for every predicate",
      async () => {
        const rows = [
          { name: "a", type: "t", option: "x", success: true },
          { name: "b", type: "t", option: "x", success: true },
          { name: "c", type: "t", option: "x", success: true },
          { name: "d", type: "t", option: "y", success: true },
          { name: "e", type: "t", option: "y", success: true },
          { name: "f", type: "t", option: "z", success: true },
        ];
        for (const row of rows) {
          await storage.put(row);
        }

        const expected: Record<string, number> = { x: 3, y: 2, z: 1, missing: 0 };
        for (const [option, expectedCount] of Object.entries(expected)) {
          const counted = await storage.count({ option });
          const queried = (await storage.query({ option })) ?? [];
          expect(
            counted,
            `count({option:"${option}"}) disagrees with query({option:"${option}"}).length`
          ).toBe(queried.length);
          expect(counted).toBe(expectedCount);
        }

        const totalCount = await storage.count();
        const allRows = (await storage.getAll()) ?? [];
        expect(totalCount).toBe(allRows.length);
        expect(totalCount).toBe(rows.length);
      },
      opts.timeout
    );
  });
}
