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

/**
 * The `{ operator: "in" }` criterion, which every backend renders differently —
 * expanded placeholders on SQLite/DuckDB, a single `= ANY($n)` array parameter
 * on Postgres, a PostgREST `in.()` filter on Supabase, and an in-memory
 * membership test elsewhere. That divergence is exactly why the semantics are
 * pinned here rather than per backend.
 */
export function inListCriterionBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("inListCriterion") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsQuery)("inListCriterion", () => {
    let storage: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    const rows = [
      { name: "a", type: "t", option: "x", success: true },
      { name: "b", type: "t", option: "y", success: true },
      { name: "c", type: "t", option: "z", success: false },
      { name: "d", type: "u", option: "x", success: false },
    ];

    beforeEach(async () => {
      storage = await opts.createStorage();
      await storage.setupDatabase?.();
      for (const row of rows) await storage.put(row);
    });

    afterEach(async () => {
      await storage.deleteAll();
      storage.destroy?.();
      await opts.releaseStorage?.(storage);
    });

    const names = (found: readonly { name: string }[]): string[] => found.map((r) => r.name).sort();

    itImpl(
      "matches every listed value and nothing else",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x", "z"], operator: "in" } })) ?? [];
        expect(names(found)).toEqual(["a", "c", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "ANDs with the other criteria columns",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x", "z"], operator: "in" }, type: "t" })) ?? [];
        expect(names(found)).toEqual(["a", "c"]);
      },
      opts.timeout
    );

    itImpl(
      "ignores values that match no row, and never duplicates a row for a repeated value",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x", "nope", "x"], operator: "in" } })) ?? [];
        expect(names(found)).toEqual(["a", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "matches nothing for an empty list",
      async () => {
        // `IN ()` is a syntax error in SQL, so every backend has to special-case
        // this; the contract is that it matches no row rather than throwing or
        // (much worse) degrading to no filter at all and matching everything.
        const found = (await storage.query({ option: { value: [], operator: "in" } })) ?? [];
        expect(found).toEqual([]);
        expect(await storage.count({ option: { value: [], operator: "in" } })).toBe(0);
      },
      opts.timeout
    );

    itImpl(
      "count agrees with query for an in-list",
      async () => {
        const criteria = { option: { value: ["x", "z"], operator: "in" as const } };
        const queried = (await storage.query(criteria)) ?? [];
        expect(await storage.count(criteria)).toBe(queried.length);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch removes exactly the listed rows",
      async () => {
        await storage.deleteSearch({ option: { value: ["x", "z"], operator: "in" } });
        const left = (await storage.getAll()) ?? [];
        expect(names(left)).toEqual(["b"]);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch with an empty list deletes nothing",
      async () => {
        await storage.deleteSearch({ option: { value: [], operator: "in" } });
        const left = (await storage.getAll()) ?? [];
        expect(left.length).toBe(rows.length);
      },
      opts.timeout
    );

    itImpl(
      "matches on a boolean column",
      async () => {
        // Booleans are stored as 0/1 by some backends, so the list elements must
        // go through the same coercion a scalar `=` value would.
        const found = (await storage.query({ success: { value: [false], operator: "in" } })) ?? [];
        expect(names(found)).toEqual(["c", "d"]);
      },
      opts.timeout
    );
  });
}
