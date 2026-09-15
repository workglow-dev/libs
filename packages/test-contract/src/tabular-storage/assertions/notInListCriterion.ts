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
 * The `{ operator: "not-in" }` criterion. Pinned here for the same reason its
 * complement is — `NOT IN (…)` on SQLite/DuckDB, `<> ALL($n)` on Postgres, a
 * PostgREST `not.in.()` filter on Supabase, a JS predicate elsewhere — plus one
 * of its own: an exclusion filter that silently matches nothing looks like an
 * empty result set rather than a bug, so the empty-list and null cases need a
 * test that says which way they are supposed to fall.
 */
export function notInListCriterionBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("notInListCriterion") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsQuery)("notInListCriterion", () => {
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
      "excludes every listed value and keeps the rest",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x", "z"], operator: "not-in" } })) ?? [];
        expect(names(found)).toEqual(["b"]);
      },
      opts.timeout
    );

    itImpl(
      "is the exact complement of the same in-list",
      async () => {
        const included = (await storage.query({ option: { value: ["x"], operator: "in" } })) ?? [];
        const excluded =
          (await storage.query({ option: { value: ["x"], operator: "not-in" } })) ?? [];
        // Every row lands on exactly one side. This only holds because no row
        // here has a null `option`; the null case is pinned separately below.
        expect([...names(included), ...names(excluded)].sort()).toEqual(["a", "b", "c", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "ANDs with the other criteria columns",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x"], operator: "not-in" }, type: "t" })) ?? [];
        expect(names(found)).toEqual(["b", "c"]);
      },
      opts.timeout
    );

    itImpl(
      "ignores values that match no row, and tolerates a repeated value",
      async () => {
        const found =
          (await storage.query({ option: { value: ["x", "nope", "x"], operator: "not-in" } })) ??
          [];
        expect(names(found)).toEqual(["b", "c"]);
      },
      opts.timeout
    );

    itImpl(
      "matches everything for an empty list",
      async () => {
        // The inverse of the empty `in` list. Excluding nothing excludes
        // nothing — a backend that reused its always-false `IN ()` predicate
        // here would invert the caller's filter and return no rows.
        const found = (await storage.query({ option: { value: [], operator: "not-in" } })) ?? [];
        expect(names(found)).toEqual(["a", "b", "c", "d"]);
        expect(await storage.count({ option: { value: [], operator: "not-in" } })).toBe(
          rows.length
        );
      },
      opts.timeout
    );

    itImpl(
      "count agrees with query for a not-in list",
      async () => {
        const criteria = { option: { value: ["x", "z"], operator: "not-in" as const } };
        const queried = (await storage.query(criteria)) ?? [];
        expect(await storage.count(criteria)).toBe(queried.length);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch removes exactly the unlisted rows",
      async () => {
        await storage.deleteSearch({ option: { value: ["x", "z"], operator: "not-in" } });
        const left = (await storage.getAll()) ?? [];
        expect(names(left)).toEqual(["a", "c", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch refuses criteria that reduce to an empty exclusion",
      async () => {
        // The empty list matches every row, so this delete would empty the
        // table — and an exclusion list is usually built from caller input, so
        // the shape that reads as a bug is the one that destroys everything.
        // `query` and `count` still answer it; only the delete refuses.
        await expect(
          storage.deleteSearch({ option: { value: [], operator: "not-in" } })
        ).rejects.toThrow(/delete the whole table/);
        const left = (await storage.getAll()) ?? [];
        expect(names(left)).toEqual(["a", "b", "c", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch still runs when another column narrows the empty exclusion",
      async () => {
        // The refusal is about criteria that name no rows in particular, not
        // about the empty list itself: `type` still restricts this one.
        await storage.deleteSearch({
          type: "u",
          option: { value: [], operator: "not-in" },
        });
        const left = (await storage.getAll()) ?? [];
        expect(names(left)).toEqual(["a", "b", "c"]);
      },
      opts.timeout
    );

    itImpl(
      "matches on a boolean column",
      async () => {
        // Booleans are stored as 0/1 by some backends, so the list elements
        // must go through the same coercion a scalar `=` value would.
        const found =
          (await storage.query({ success: { value: [false], operator: "not-in" } })) ?? [];
        expect(names(found)).toEqual(["a", "b"]);
      },
      opts.timeout
    );

    itImpl(
      "matches nothing when the list contains null",
      async () => {
        // SQL's three-valued logic: `col NOT IN (…, NULL)` is UNKNOWN for every
        // row that is not already excluded, so no row survives. Reproduced
        // rather than papered over, so the abstraction and the database it
        // stands in for cannot disagree.
        // Cast because `option` is a non-nullable column, so the typed API
        // cannot express this — but criteria arrive as untyped JSON at the
        // HTTP-proxy boundary, so a backend still has to answer for it.
        const found =
          (await storage.query({
            option: { value: ["x", null], operator: "not-in" },
          } as unknown as Parameters<typeof storage.query>[0])) ?? [];
        expect(found).toEqual([]);
      },
      opts.timeout
    );

    // The SQL backends hand `fn` a Proxy that routes `tx.<method>` to the
    // private `_<method>Internal`, so a guard placed only on the public
    // `deleteSearch` is skipped by every call made through `tx`.
    describe.skipIf(!opts.capabilities.supportsTransactions)("through a transaction handle", () => {
      itImpl(
        "refuses an empty exclusion there too",
        async () => {
          // Unguarded this renders `WHERE 1 = 1` and empties the table.
          await expect(
            storage.withTransaction(async (tx) => {
              await tx.deleteSearch({ option: { value: [], operator: "not-in" } });
            })
          ).rejects.toThrow(/delete the whole table/);
          const left = (await storage.getAll()) ?? [];
          expect(names(left)).toEqual(["a", "b", "c", "d"]);
        },
        opts.timeout
      );

      itImpl(
        "keeps empty criteria a no-op there too",
        async () => {
          // The other half of the same bypass: unguarded this builds
          // `DELETE FROM t WHERE ` and fails with a SQL syntax error.
          await storage.withTransaction(async (tx) => {
            await tx.deleteSearch({});
          });
          const left = (await storage.getAll()) ?? [];
          expect(names(left)).toEqual(["a", "b", "c", "d"]);
        },
        opts.timeout
      );
    });
  });
}
