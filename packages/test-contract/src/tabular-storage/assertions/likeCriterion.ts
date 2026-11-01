/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { escapeLikePattern, StorageValidationError } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

/**
 * The `{ operator: "like" }` criterion. Every backend spells it differently —
 * `LIKE … ESCAPE '\'` on PostgreSQL and DuckDB, a translated `GLOB` on SQLite
 * (whose own LIKE ignores ASCII case), PostgREST `like` or `match` on Supabase,
 * a JS matcher elsewhere — and each has its own way of disagreeing: case
 * folding, a different default escape, a wildcard that is not one character,
 * a server that rewrites `*`. The cases here are the ones that tell them apart.
 * The null-column rule lives with the nullable fixtures in the generic suite.
 */
export function likeCriterionBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("likeCriterion") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsQuery)("likeCriterion", () => {
    let storage: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    const rows = [
      { name: "a", type: "t", option: "5.02,9.01", success: true },
      { name: "b", type: "t", option: "5.0x2", success: true },
      { name: "c", type: "u", option: "50% off_now", success: false },
      { name: "d", type: "u", option: "Item 5.02", success: false },
      { name: "e", type: "t", option: "line one\nline two", success: true },
      { name: "f", type: "t", option: "ITEM 5.02", success: false },
      { name: "g", type: "u", option: "off-now", success: true },
      { name: "h", type: "t", option: "star*and[bracket]?", success: true },
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

    const names = (found: readonly { name: string }[] | undefined): string[] =>
      (found ?? []).map((r) => r.name).sort();
    const like = async (pattern: string): Promise<string[]> =>
      names(await storage.query({ option: { value: pattern, operator: "like" } }));

    itImpl(
      "matches a substring with %…%",
      async () => {
        expect(await like("%5.02%")).toEqual(["a", "d", "f"]);
        expect(await like("%nope%")).toEqual([]);
      },
      opts.timeout
    );

    itImpl(
      "is anchored: a prefix needs a trailing %, a suffix a leading one",
      async () => {
        expect(await like("5.0%")).toEqual(["a", "b"]);
        expect(await like("%5.02")).toEqual(["d", "f"]);
        expect(await like("5.02")).toEqual([]);
        expect(await like("off-now")).toEqual(["g"]);
      },
      opts.timeout
    );

    itImpl(
      "reads _ as exactly one character",
      async () => {
        expect(await like("5.0_2")).toEqual(["b"]);
        expect(await like("5.0_")).toEqual([]);
        expect(await like("%off_now")).toEqual(["c", "g"]);
      },
      opts.timeout
    );

    itImpl(
      "matches an escaped % or _ literally",
      async () => {
        expect(await like("%\\%%")).toEqual(["c"]);
        expect(await like("%off\\_now")).toEqual(["c"]);
        expect(await like(`%${escapeLikePattern("50% off_")}%`)).toEqual(["c"]);
      },
      opts.timeout
    );

    itImpl(
      "is case-sensitive",
      async () => {
        expect(await like("Item%")).toEqual(["d"]);
        expect(await like("ITEM%")).toEqual(["f"]);
        expect(await like("item%")).toEqual([]);
      },
      opts.timeout
    );

    itImpl(
      "lets % span a newline",
      async () => {
        expect(await like("line%two")).toEqual(["e"]);
      },
      opts.timeout
    );

    itImpl(
      "treats *, ?, [ and ] as ordinary characters",
      async () => {
        // GLOB and PostgREST both give these a meaning of their own; under
        // LIKE they are literal.
        expect(await like("star*and[bracket]?")).toEqual(["h"]);
        expect(await like("%*%")).toEqual(["h"]);
        expect(await like("star\\*and%")).toEqual(["h"]);
        expect(await like("starand%")).toEqual([]);
        expect(await like("%[bracket]_")).toEqual(["h"]);
      },
      opts.timeout
    );

    itImpl(
      "ANDs with the other criteria columns",
      async () => {
        const found = await storage.query({
          option: { value: "%5.02%", operator: "like" },
          type: "u",
        });
        expect(names(found)).toEqual(["d"]);
        const listed = await storage.query({
          option: { value: "%5.02%", operator: "like" },
          name: { value: ["a", "d"], operator: "in" },
        });
        expect(names(listed)).toEqual(["a", "d"]);
      },
      opts.timeout
    );

    itImpl(
      "count agrees with query",
      async () => {
        const criteria = { option: { value: "%5.02%", operator: "like" as const } };
        expect(await storage.count(criteria)).toBe(3);
      },
      opts.timeout
    );

    itImpl(
      "refuses a value that is not a string",
      async () => {
        // Criteria arrive as untyped JSON at the HTTP-proxy boundary, so the
        // typed API's restriction is not enough on its own.
        const criteria = { option: { value: 502, operator: "like" } } as unknown as Parameters<
          typeof storage.query
        >[0];
        await expect(storage.query(criteria)).rejects.toBeInstanceOf(StorageValidationError);
      },
      opts.timeout
    );

    itImpl(
      "refuses a pattern ending in a lone escape",
      async () => {
        await expect(
          storage.query({ option: { value: "abc\\", operator: "like" } })
        ).rejects.toBeInstanceOf(StorageValidationError);
      },
      opts.timeout
    );

    itImpl(
      "deleteSearch removes exactly the matching rows",
      async () => {
        await storage.deleteSearch({ option: { value: "%5.02%", operator: "like" } });
        expect(names(await storage.getAll())).toEqual(["b", "c", "e", "g", "h"]);
      },
      opts.timeout
    );

    itImpl(
      "updateWhere matches by pattern",
      async () => {
        const updated = await storage.updateWhere(
          { option: { value: "%\\%%", operator: "like" } },
          { success: true }
        );
        expect(updated?.name).toBe("c");
        expect((await storage.get({ name: "c", type: "u" }))?.success).toBe(true);
        expect(
          await storage.updateWhere(
            { option: { value: "zzz%", operator: "like" } },
            { success: true }
          )
        ).toBeUndefined();
      },
      opts.timeout
    );
  });
}
