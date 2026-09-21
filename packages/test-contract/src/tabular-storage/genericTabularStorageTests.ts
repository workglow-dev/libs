/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage, PageCursor } from "@workglow/storage";
import { StorageUnsupportedError, StorageValidationError } from "@workglow/storage";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The row shape the rest of the contract suites read. Re-exported because this
// file's own suites use the same rows.
import { CompoundPrimaryKeyNames, CompoundSchema } from "./fixtures";

export { CompoundPrimaryKeyNames, CompoundSchema };

export const PAYLOADS = [
  "id); DROP TABLE x;--",
  "id;--",
  "id,id",
  "(SELECT 1)",
  "id--",
  "1=1",
  'id")"',
  "id\\",
  "id.x",
  "",
  " ",
];

export const SearchPrimaryKeyNames = ["id"] as const;
export const SearchSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    category: { type: "string" },
    subcategory: { type: "string" },
    kind: { type: "string" },
    // Indexed and optional, so a null criterion on it exercises the index
    // planner on every backend. `kind` stays deliberately unindexed — two tests
    // below rely on that to cover the no-covering-index and partial-narrowing
    // paths. Keep `tag` out of `required`: a required column is emitted
    // `NOT NULL` in SQL, which would reject every existing `put`.
    tag: { type: "string" },
    value: { type: "number" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "category", "subcategory", "value", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const NullableSearchPrimaryKeyNames = ["id"] as const;
export const NullableSearchSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    category: { type: "string" },
    subcategory: { type: "string" },
    value: { anyOf: [{ type: "number" }, { type: "null" }] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const AllTypesPrimaryKeyNames = ["id"] as const;
export const AllTypesSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    textField: { type: "string" },
    numberField: { type: "number" },
    integerField: { type: "integer" },
    booleanField: { type: "boolean" },
    arrayField: { type: "array", items: { type: "string" } },
    objectField: { type: "object", default: {} },
    nestedObjectField: { type: "object", default: {} },
  },
  required: [
    "id",
    "textField",
    "numberField",
    "integerField",
    "booleanField",
    "arrayField",
    "objectField",
    "nestedObjectField",
  ],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const AutoIncrementPrimaryKeyNames = ["id"] as const;
export const AutoIncrementSchema = {
  type: "object",
  properties: {
    id: { type: "integer", "x-auto-generated": true },
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["id", "name", "email"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const UuidPrimaryKeyNames = ["id"] as const;
export const UuidSchema = {
  type: "object",
  properties: {
    id: { type: "string", "x-auto-generated": true },
    title: { type: "string" },
    content: { type: "string" },
  },
  required: ["id", "title", "content"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export function runGenericTabularStorageTests(
  createCompoundPkRepository: () => Promise<
    ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>
  >,
  createSearchableRepository?: () => Promise<
    ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>
  >,
  createAllTypesRepository?: () => Promise<
    ITabularStorage<typeof AllTypesSchema, typeof AllTypesPrimaryKeyNames>
  >
) {
  describe("with compound primary keys", () => {
    let repository: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(async () => {
      repository = await createCompoundPkRepository();
      await repository.setupDatabase?.();
    });

    afterEach(async () => {
      await repository.deleteAll();
      repository.destroy();
    });

    it("should store and retrieve values for a key", async () => {
      const key = { name: "key1", type: "string1" };
      const entity = { ...key, option: "value1", success: true };
      await repository.put(entity);
      const output = await repository.get(key);

      expect(output?.option).toEqual("value1");
      expect(!!output?.success).toEqual(true);
    });

    it("should get undefined for a key that doesn't exist", async () => {
      const key = { name: "key", type: "string" };
      const output = await repository.get(key);

      expect(output == undefined).toEqual(true);
    });

    it("should store multiple entities using putBulk", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
        { name: "key3", type: "string3", option: "value3", success: true },
      ];

      await repository.putBulk(entities);

      for (const entity of entities) {
        const output = await repository.get({ name: entity.name, type: entity.type });
        expect(output?.option).toEqual(entity.option);
        expect(!!output?.success).toEqual(entity.success);
      }
    });

    it("should handle empty array in putBulk", async () => {
      await repository.putBulk([]);
    });

    it("should return the entity from put()", async () => {
      const key = { name: "key1", type: "string1" };
      const entity = { ...key, option: "value1", success: true };

      const returned = await repository.put(entity);

      expect(returned).toBeDefined();
      expect(returned.name).toEqual(entity.name);
      expect(returned.type).toEqual(entity.type);
      expect(returned.option).toEqual(entity.option);
      expect(!!returned.success).toEqual(entity.success);
    });

    it("should return updated entity from put() when upserting", async () => {
      const key = { name: "key1", type: "string1" };
      const entity1 = { ...key, option: "value1", success: true };
      const entity2 = { ...key, option: "value2", success: false };

      const returned1 = await repository.put(entity1);
      expect(returned1.option).toEqual("value1");
      expect(!!returned1.success).toEqual(true);

      // upsert overwrites
      const returned2 = await repository.put(entity2);
      expect(returned2.option).toEqual("value2");
      expect(!!returned2.success).toEqual(false);

      const stored = await repository.get(key);
      expect(stored?.option).toEqual("value2");
      expect(!!stored?.success).toEqual(false);
    });

    it("should return array of entities from putBulk()", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
        { name: "key3", type: "string3", option: "value3", success: true },
      ];

      const returned = await repository.putBulk(entities);

      expect(returned).toBeDefined();
      expect(returned.length).toEqual(3);

      for (let i = 0; i < entities.length; i++) {
        expect(returned[i].name).toEqual(entities[i].name);
        expect(returned[i].type).toEqual(entities[i].type);
        expect(returned[i].option).toEqual(entities[i].option);
        expect(!!returned[i].success).toEqual(entities[i].success);
      }
    });

    it("should return empty array from putBulk() with empty input", async () => {
      const returned = await repository.putBulk([]);

      expect(returned).toBeDefined();
      expect(Array.isArray(returned)).toBe(true);
      expect(returned.length).toEqual(0);
    });

    it("should return putBulk() entities in the same order as the input", async () => {
      // Inputs deliberately interleave name/type combos so any backend that
      // returns rows in PK order (rather than input order) would mismatch.
      const entities = [
        { name: "key3", type: "string3", option: "third", success: true },
        { name: "key1", type: "string1", option: "first", success: false },
        { name: "key2", type: "string2", option: "second", success: true },
      ];

      const returned = await repository.putBulk(entities);

      expect(returned).toHaveLength(entities.length);
      for (let i = 0; i < entities.length; i++) {
        expect(returned[i].name).toEqual(entities[i].name);
        expect(returned[i].type).toEqual(entities[i].type);
        expect(returned[i].option).toEqual(entities[i].option);
      }
    });

    it("should store and return a batch larger than the SQL parameter limit in order", async () => {
      const count = 2000;
      const entities = Array.from({ length: count }, (_, i) => ({
        name: `bulk${i}`,
        type: `t${i % 7}`,
        option: `v${i}`,
        success: i % 2 === 0,
      }));

      const returned = await repository.putBulk(entities);

      expect(returned).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        expect(returned[i].name).toEqual(entities[i].name);
        expect(returned[i].type).toEqual(entities[i].type);
        expect(returned[i].option).toEqual(entities[i].option);
      }
      const stored = await repository.get({ name: "bulk1999", type: "t4" });
      expect(stored?.option).toEqual("v1999");
    });

    it("should apply last-write-wins for duplicate primary keys within one putBulk batch", async () => {
      const entities = [
        { name: "dup", type: "k", option: "first", success: true },
        { name: "other", type: "k", option: "kept", success: true },
        { name: "dup", type: "k", option: "last", success: false },
      ];

      await repository.putBulk(entities);

      const stored = await repository.get({ name: "dup", type: "k" });
      expect(stored?.option).toEqual("last");
      expect(!!stored?.success).toEqual(false);
      const other = await repository.get({ name: "other", type: "k" });
      expect(other?.option).toEqual("kept");
    });

    it("should not collide distinct composite keys whose values contain the separator", async () => {
      const entities = [
        { name: "a b", type: "c", option: "first", success: true },
        { name: "a", type: "b c", option: "second", success: true },
      ];
      const returned = await repository.putBulk(entities);
      expect(returned).toHaveLength(2);
      // Distinct rows — neither collapsed into the other.
      expect((await repository.get({ name: "a b", type: "c" }))?.option).toEqual("first");
      expect((await repository.get({ name: "a", type: "b c" }))?.option).toEqual("second");
    });

    describe("withTransaction", () => {
      it("should commit writes performed inside a successful transaction", async () => {
        await repository.withTransaction(async (tx) => {
          await tx.put({ name: "tx1", type: "ok", option: "committed", success: true });
          await tx.put({ name: "tx2", type: "ok", option: "committed", success: true });
        });

        const r1 = await repository.get({ name: "tx1", type: "ok" });
        const r2 = await repository.get({ name: "tx2", type: "ok" });
        expect(r1?.option).toEqual("committed");
        expect(r2?.option).toEqual("committed");
      });

      it("should propagate the result of the transaction callback", async () => {
        const result = await repository.withTransaction(async (tx) => {
          await tx.put({ name: "tx", type: "result", option: "val", success: true });
          return 42;
        });
        expect(result).toEqual(42);
      });
    });
  });

  if (createSearchableRepository) {
    describe("with searchable indexes", () => {
      let searchableRepo: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        searchableRepo = await createSearchableRepository();
        await searchableRepo.setupDatabase?.();
      });

      afterEach(async () => {
        await searchableRepo.deleteAll();
        searchableRepo.destroy();
      });

      it("matches NULL columns with a null criterion", async () => {
        // `col = NULL` is never true in SQL, so a null criterion used to match
        // zero rows rather than the rows holding NULL. It failed silently and
        // in the worst direction: a "find by tuple, else create" repo missed
        // every time and created a duplicate on every call.
        const now = new Date().toISOString();
        await searchableRepo.put({
          id: "null-kind",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "set-kind",
          category: "electronics",
          subcategory: "phones",
          kind: "premium",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const nullMatches = await searchableRepo.query({ kind: null } as never);
        expect(nullMatches?.map((r) => r.id)).toEqual(["null-kind"]);

        // Mixed with a non-null column, which is the shape a lookup tuple takes.
        const mixed = await searchableRepo.query({
          category: "electronics",
          kind: null,
        } as never);
        expect(mixed?.map((r) => r.id)).toEqual(["null-kind"]);

        // The non-null side must keep working unchanged.
        const setMatches = await searchableRepo.query({ kind: "premium" } as never);
        expect(setMatches?.map((r) => r.id)).toEqual(["set-kind"]);
      });

      it("matches nothing for an `undefined` criterion, on every backend", async () => {
        // What a spread optional filter leaves behind: `{ ...maybe }` where
        // `maybe` is `{ kind: undefined }` puts the key in `Object.keys` with
        // no value. It is NOT read as "no filter" — the SQL backends bind it
        // as NULL and `col = NULL` is never true, so no row matches, and the
        // JS-side backends agree. They did not always: read as a plain `===`,
        // an `undefined` criterion returned exactly the rows whose column was
        // absent, which is the answer no database gives.
        const now = new Date().toISOString();
        await searchableRepo.put({
          id: "no-kind",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "with-kind",
          category: "electronics",
          subcategory: "phones",
          kind: "premium",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const ids = async (criteria: unknown): Promise<string[]> =>
          ((await searchableRepo.query(criteria as never)) ?? []).map((r) => r.id).sort();

        // Alone, and mixed with a criterion that would otherwise match.
        expect(await ids({ kind: undefined })).toEqual([]);
        expect(await ids({ category: "electronics", kind: undefined })).toEqual([]);
        // `!=` does not invert it into a no-op: `col != NULL` is UNKNOWN too.
        expect(await ids({ kind: { value: undefined, operator: "!=" } })).toEqual([]);
        // `null` remains the way to ask for the rows without a kind.
        expect(await ids({ kind: null })).toEqual(["no-kind"]);
        // And an ordinary criterion is untouched.
        expect(await ids({ kind: "premium" })).toEqual(["with-kind"]);
      });

      it("never matches a NULL column with an `in` list, whatever the list holds", async () => {
        // SQL reads `NULL IN (…)` as UNKNOWN and drops the row, and listing
        // `null` does not rescue it — `x IN (NULL)` is UNKNOWN too. The SQL
        // backends get this free by binding the list to `IN` / `= ANY`; the
        // JS-side backends used to answer a listed `null` with a JS-native
        // `null === null` and return the null rows the SQL backends dropped.
        // Runs on `kind` (unindexed, so every backend scans) and `tag`
        // (indexed, so the index planner sees it too).
        const now = new Date().toISOString();
        await searchableRepo.put({
          id: "null-both",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "set-both",
          category: "electronics",
          subcategory: "phones",
          kind: "premium",
          tag: "a",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const ids = async (criteria: unknown): Promise<string[]> =>
          ((await searchableRepo.query(criteria as never)) ?? []).map((r) => r.id).sort();

        for (const column of ["kind", "tag"] as const) {
          const listed = column === "kind" ? "premium" : "a";
          // A list of only null names no row at all.
          expect(await ids({ [column]: { value: [null], operator: "in" } })).toEqual([]);
          // Adding null to a list that does match changes nothing.
          expect(await ids({ [column]: { value: [listed], operator: "in" } })).toEqual([
            "set-both",
          ]);
          expect(await ids({ [column]: { value: [listed, null], operator: "in" } })).toEqual([
            "set-both",
          ]);
          // A null column is excluded from `not-in` as well — both sides are
          // UNKNOWN, so the row falls out of each rather than one of them.
          expect(await ids({ [column]: { value: [listed], operator: "not-in" } })).toEqual([]);
          // The way to ask for the null rows, unchanged.
          expect(await ids({ [column]: null })).toEqual(["null-both"]);
        }
      });

      it("matches NULL on an indexed column with a null criterion", async () => {
        // The same rule as above, but on a column the backend has an index for.
        // That is the path the previous test never reached: it used `kind`,
        // which is in no index, so every backend answered it with a scan and
        // the cross-backend claim went untested against an index planner.
        const now = new Date().toISOString();
        await searchableRepo.put({
          id: "no-tag",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "with-tag",
          category: "electronics",
          subcategory: "phones",
          tag: "a",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const nullMatches = await searchableRepo.query({ tag: null } as never);
        expect(nullMatches?.map((r) => r.id)).toEqual(["no-tag"]);

        // Compound-index prefix shape: a non-null leading column plus a null
        // one, which is what a "look up by tuple, else create" repo issues.
        const compound = await searchableRepo.query({
          category: "electronics",
          tag: null,
        } as never);
        expect(compound?.map((r) => r.id)).toEqual(["no-tag"]);

        expect(await searchableRepo.count({ tag: null } as never)).toBe(1);

        const setMatches = await searchableRepo.query({ tag: "a" } as never);
        expect(setMatches?.map((r) => r.id)).toEqual(["with-tag"]);
      });

      it("supports != , including its null form", async () => {
        const now = new Date().toISOString();
        await searchableRepo.put({
          id: "null-kind",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "premium",
          category: "electronics",
          subcategory: "phones",
          kind: "premium",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });
        await searchableRepo.put({
          id: "budget",
          category: "electronics",
          subcategory: "phones",
          kind: "budget",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });

        // `!= null` is IS NOT NULL — every row that holds a value.
        const notNull = await searchableRepo.query({
          kind: { value: null, operator: "!=" },
        } as never);
        expect(notNull?.map((r) => r.id).sort()).toEqual(["budget", "premium"]);

        // `!= <value>` follows SQL three-valued logic: the NULL row is NOT
        // returned, because `null != 'premium'` is UNKNOWN rather than true.
        // A JS-native `!==` would wrongly include it, and the backends would
        // then disagree with each other.
        const notPremium = await searchableRepo.query({
          kind: { value: "premium", operator: "!=" },
        } as never);
        expect(notPremium?.map((r) => r.id)).toEqual(["budget"]);
      });

      it("should store and search using compound indexes", async () => {
        await searchableRepo.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await searchableRepo.put({
          id: "2",
          category: "electronics",
          subcategory: "laptops",
          value: 200,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await searchableRepo.put({
          id: "3",
          category: "books",
          subcategory: "fiction",
          value: 300,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const electronicsOnly = await searchableRepo.query({ category: "electronics" });
        expect(electronicsOnly?.length).toBe(2);
        expect(electronicsOnly?.map((item) => item.id).sort()).toEqual(["1", "2"]);

        const electronicsPhones = await searchableRepo.query({
          category: "electronics",
          subcategory: "phones",
        });
        expect(electronicsPhones?.length).toBe(1);
        expect(electronicsPhones?.[0].id).toBe("1");

        const nonExistent = await searchableRepo.query({
          category: "electronics",
          subcategory: "tablets",
        });
        expect(nonExistent).toBeUndefined();
      });

      it("should handle searching with multiple criteria in different orders", async () => {
        await searchableRepo.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await searchableRepo.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Criteria order should not matter
        const search1 = await searchableRepo.query({
          category: "electronics",
          subcategory: "phones",
        });
        const search2 = await searchableRepo.query({
          subcategory: "phones",
          category: "electronics",
        });

        expect(search1?.length).toBe(2);
        expect(search2?.length).toBe(2);
        expect(search1?.map((item) => item.id).sort()).toEqual(["1", "2"]);
        expect(search2?.map((item) => item.id).sort()).toEqual(["1", "2"]);
      });

      it("should handle partial matches with compound indexes", async () => {
        await searchableRepo.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await searchableRepo.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await searchableRepo.put({
          id: "3",
          category: "electronics",
          subcategory: "laptops",
          value: 300,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Search with value field
        const highValue = await searchableRepo.query({ value: 300 });
        expect(highValue?.length).toBe(1);
        expect(highValue?.[0].id).toBe("3");

        const expensivePhones = await searchableRepo.query({
          subcategory: "phones",
          value: 200,
        });
        expect(expensivePhones?.length).toBe(1);
        expect(expensivePhones?.[0].id).toBe("2");
      });
    });

    describe(`deleteSearch tests`, () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should delete entries older than a specified date using createdAt", async () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: yesterday,
          updatedAt: yesterday,
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: twoDaysAgo,
          updatedAt: twoDaysAgo,
        });
        await repository.put({
          id: "4",
          category: "electronics",
          subcategory: "phones",
          value: 400,
          createdAt: threeDaysAgo,
          updatedAt: threeDaysAgo,
        });

        expect((await repository.getAll())?.length).toBe(4);

        await repository.deleteSearch({ createdAt: { value: yesterday, operator: "<" } });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["1", "2"]);
      });

      it("should delete entries older than a specified date using updatedAt", async () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: twoDaysAgo,
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: twoDaysAgo,
        });
        await repository.put({
          id: "4",
          category: "electronics",
          subcategory: "phones",
          value: 400,
          createdAt: twoDaysAgo,
          updatedAt: twoDaysAgo,
        });

        expect((await repository.getAll())?.length).toBe(4);

        await repository.deleteSearch({ updatedAt: { value: yesterday, operator: "<" } });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["1", "2"]);
      });

      it("should handle empty repository gracefully", async () => {
        expect(await repository.getAll()).toBeUndefined();

        const result = await repository.deleteSearch({
          createdAt: { value: new Date().toISOString(), operator: "<" },
        });
        expect(result).toBeUndefined();
      });

      it("should not delete entries when none are older than the specified date", async () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: yesterday.toISOString(),
        });
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
        await repository.deleteSearch({ createdAt: { value: threeDaysAgo, operator: "<" } });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
      });

      it("should delete entries with < operator", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: { value: 200, operator: "<" } });
        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["2", "3"]);
      });

      it("should delete entries with <= operator", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: { value: 200, operator: "<=" } });
        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(1);
        expect(remaining?.[0].id).toBe("3");
      });

      it("should delete entries with > operator", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: { value: 200, operator: ">" } });
        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["1", "2"]);
      });

      it("should delete entries with >= operator", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: { value: 200, operator: ">=" } });
        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(1);
        expect(remaining?.[0].id).toBe("1");
      });

      it("should handle = operator for exact matches", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: 200 });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(1);
        expect(remaining?.[0].id).toBe("1");
        expect(remaining?.[0].value).toBe(100);
      });

      it("should correctly handle null/undefined column values in comparisons", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        await repository.deleteSearch({ value: { value: 200, operator: "<" } });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["2", "3"]);
      });

      it("should delete entries matching multiple criteria", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "laptops",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "books",
          subcategory: "fiction",
          value: 150,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "4",
          category: "electronics",
          subcategory: "phones",
          value: 300,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        // Delete electronics with value >= 200
        await repository.deleteSearch({
          category: "electronics",
          value: { value: 200, operator: ">=" },
        });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["1", "3"]);
      });

      it("should delete entries matching multiple equality criteria", async () => {
        const now = new Date();

        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "laptops",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await repository.put({
          id: "4",
          category: "books",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });

        // Delete electronics phones
        await repository.deleteSearch({
          category: "electronics",
          subcategory: "phones",
        });

        const remaining = await repository.getAll();
        expect(remaining?.length).toBe(2);
        expect(remaining?.map((item) => item.id).sort()).toEqual(["3", "4"]);
      });
    });

    describe("updateWhere tests", () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository!();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("updates a row matched by equality and returns the new row", async () => {
        const ts = new Date().toISOString();
        await repository.put({
          id: "u1",
          category: "a",
          subcategory: "s",
          value: 1,
          createdAt: ts,
          updatedAt: ts,
        } as never);
        const updated = await repository.updateWhere(
          { id: "u1" } as never,
          { category: "b" } as never
        );
        expect((updated as { category?: string } | undefined)?.category).toBe("b");
        const read = (await repository.get({ id: "u1" } as never)) as
          | { category?: string }
          | undefined;
        expect(read?.category).toBe("b");
      });

      it("only updates when a conditional predicate matches (CAS)", async () => {
        const ts = new Date().toISOString();
        await repository.put({
          id: "u2",
          category: "a",
          subcategory: "s",
          value: 10,
          createdAt: ts,
          updatedAt: ts,
        } as never);

        const hit = await repository.updateWhere(
          { id: "u2", value: { value: 20, operator: "<" } } as never,
          { category: "hit" } as never
        );
        expect((hit as { category?: string } | undefined)?.category).toBe("hit");

        const miss = await repository.updateWhere(
          { id: "u2", value: { value: 5, operator: "<" } } as never,
          { category: "miss" } as never
        );
        expect(miss).toBeUndefined();
        const read = (await repository.get({ id: "u2" } as never)) as
          | { category?: string }
          | undefined;
        expect(read?.category).toBe("hit");
      });

      it("returns undefined for an unmatched row", async () => {
        const res = await repository.updateWhere(
          { id: "nope" } as never,
          { category: "x" } as never
        );
        expect(res).toBeUndefined();
      });

      it("updates exactly one row when several match a non-unique predicate", async () => {
        const ts = new Date().toISOString();
        for (const id of ["m1", "m2", "m3"]) {
          await repository.put({
            id,
            category: "grp",
            subcategory: "s",
            value: 1,
            createdAt: ts,
            updatedAt: ts,
          } as never);
        }
        // `category: "grp"` matches all three; only one may be mutated.
        const updated = await repository.updateWhere(
          { category: "grp" } as never,
          { value: 999 } as never
        );
        expect((updated as { value?: number } | undefined)?.value).toBe(999);
        const changed = (await repository.query({ value: 999 } as never)) ?? [];
        expect(changed.length).toBe(1);
      });

      it("rejects a patch that changes a primary-key column", async () => {
        const ts = new Date().toISOString();
        await repository.put({
          id: "pk1",
          category: "a",
          subcategory: "s",
          value: 1,
          createdAt: ts,
          updatedAt: ts,
        } as never);
        // `id` is the primary key; updateWhere updates a row in place and must
        // not move its identity.
        await expect(
          repository.updateWhere({ id: "pk1" } as never, { id: "pk2" } as never)
        ).rejects.toThrow();
        // The original row is untouched.
        expect(await repository.get({ id: "pk1" } as never)).toBeDefined();
        expect(await repository.get({ id: "pk2" } as never)).toBeUndefined();
      });

      it("rejects a primary-key patch made through the transaction handle", async () => {
        // The `tx` handle a backend hands its `withTransaction` callback is a
        // Proxy that routes each method straight to its unlocked internal
        // implementation, so a guard sitting only on the public method is
        // skipped by every call made through `tx`. On the SQL backends that
        // built an `UPDATE ... SET id = ?` and rewrote the row's identity —
        // silently, or as a mid-transaction UNIQUE violation — while the same
        // call outside a transaction threw. The guard belongs on the path both
        // spellings share.
        const ts = new Date().toISOString();
        await repository.put({
          id: "txpk1",
          category: "a",
          subcategory: "s",
          value: 1,
          createdAt: ts,
          updatedAt: ts,
        } as never);

        await expect(
          repository.withTransaction(async (tx) => {
            await tx.updateWhere({ id: "txpk1" } as never, { id: "txpk2" } as never);
          })
        ).rejects.toThrow(/primary-key column/);

        // Identity untouched: neither renamed in place nor duplicated.
        expect(await repository.get({ id: "txpk1" } as never)).toBeDefined();
        expect(await repository.get({ id: "txpk2" } as never)).toBeUndefined();
      });

      it("is CAS under a raced update on the same match", async () => {
        // Two updateWhere calls with the same before-value predicate race for a
        // single row. A genuine CAS implementation must let exactly one win —
        // an unlocked read-modify-write would let both "succeed" and the last
        // writer would silently clobber the first.
        const ts = new Date().toISOString();
        await repository.put({
          id: "cas1",
          category: "a",
          subcategory: "s",
          value: 0,
          createdAt: ts,
          updatedAt: ts,
        } as never);

        const [a, b] = await Promise.all([
          repository.updateWhere({ id: "cas1", value: 0 } as never, { value: 1 } as never),
          repository.updateWhere({ id: "cas1", value: 0 } as never, { value: 2 } as never),
        ]);
        const winners = [a, b].filter(Boolean) as Array<{ value: number }>;
        expect(winners).toHaveLength(1);
        const row = (await repository.get({ id: "cas1" } as never)) as
          | { value: number }
          | undefined;
        expect(row?.value).toBe(winners[0]!.value);
      });
    });

    describe(`query tests`, () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("rejects adversarial orderBy columns before executing reads", async () => {
        for (const payload of PAYLOADS) {
          const orderBy = [{ column: payload as any, direction: "ASC" as const }];

          await expect(repository.getPage({ orderBy })).rejects.toThrow(StorageValidationError);
          await expect(
            repository.queryPage({ category: "electronics" }, { orderBy })
          ).rejects.toThrow(StorageValidationError);
          await expect(repository.getAll({ orderBy })).rejects.toThrow(StorageValidationError);
          await expect(repository.query({ category: "electronics" }, { orderBy })).rejects.toThrow(
            StorageValidationError
          );
        }
      });

      it("rejects adversarial orderBy directions before executing reads", async () => {
        const orderBy = [{ column: "id" as const, direction: "ASC; DROP--" as any }];

        await expect(repository.getPage({ orderBy })).rejects.toThrow(StorageValidationError);
        await expect(
          repository.queryPage({ category: "electronics" }, { orderBy })
        ).rejects.toThrow(StorageValidationError);
        await expect(repository.getAll({ orderBy })).rejects.toThrow(StorageValidationError);
        await expect(repository.query({ category: "electronics" }, { orderBy })).rejects.toThrow(
          StorageValidationError
        );
      });

      it("rejects non-string orderBy columns before executing reads", async () => {
        const orderBy = [{ column: 1 as any, direction: "ASC" as const }];

        await expect(repository.getPage({ orderBy })).rejects.toThrow(StorageValidationError);
        await expect(
          repository.queryPage({ category: "electronics" }, { orderBy })
        ).rejects.toThrow(StorageValidationError);
        await expect(repository.getAll({ orderBy })).rejects.toThrow(StorageValidationError);
        await expect(repository.query({ category: "electronics" }, { orderBy })).rejects.toThrow(
          StorageValidationError
        );
      });

      it("should return matching entries with equality criteria", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "books",
          subcategory: "fiction",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.query({ category: "electronics" });
        expect(results?.length).toBe(1);
        expect(results?.[0].id).toBe("1");
      });

      it("should return entries matching comparison operators", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "laptops",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "tablets",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });

        const lessThan = await repository.query({ value: { value: 200, operator: "<" } });
        expect(lessThan?.length).toBe(1);
        expect(lessThan?.[0].id).toBe("1");

        const lessOrEqual = await repository.query({ value: { value: 200, operator: "<=" } });
        expect(lessOrEqual?.length).toBe(2);
        expect(lessOrEqual?.map((r) => r.id).sort()).toEqual(["1", "2"]);

        const greaterThan = await repository.query({ value: { value: 200, operator: ">" } });
        expect(greaterThan?.length).toBe(1);
        expect(greaterThan?.[0].id).toBe("3");

        const greaterOrEqual = await repository.query({
          value: { value: 200, operator: ">=" },
        });
        expect(greaterOrEqual?.length).toBe(2);
        expect(greaterOrEqual?.map((r) => r.id).sort()).toEqual(["2", "3"]);
      });

      it("should order results by ASC", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "a",
          subcategory: "x",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "a",
          subcategory: "x",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "3",
          category: "a",
          subcategory: "x",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.getAll({
          orderBy: [{ column: "value", direction: "ASC" }],
        });
        expect(results?.length).toBe(3);
        expect(results?.map((r) => r.value)).toEqual([100, 200, 300]);
      });

      it("should order results by DESC", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "a",
          subcategory: "x",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "a",
          subcategory: "x",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "3",
          category: "a",
          subcategory: "x",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.getAll({
          orderBy: [{ column: "value", direction: "DESC" }],
        });
        expect(results?.length).toBe(3);
        expect(results?.map((r) => r.value)).toEqual([300, 200, 100]);
      });

      it("should limit results", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "a",
          subcategory: "x",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "a",
          subcategory: "x",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "3",
          category: "a",
          subcategory: "x",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.getAll({
          orderBy: [{ column: "value", direction: "ASC" }],
          limit: 2,
        });
        expect(results?.length).toBe(2);
        expect(results?.map((r) => r.value)).toEqual([100, 200]);
      });

      it("should combine criteria, orderBy, and limit", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "electronics",
          subcategory: "laptops",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "3",
          category: "electronics",
          subcategory: "tablets",
          value: 300,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "4",
          category: "books",
          subcategory: "fiction",
          value: 50,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.query(
          { category: "electronics" },
          { orderBy: [{ column: "value", direction: "DESC" }], limit: 2 }
        );
        expect(results?.length).toBe(2);
        expect(results?.map((r) => r.value)).toEqual([300, 200]);
      });

      it("should return all entries with getAll and orderBy", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "b",
          subcategory: "x",
          value: 200,
          createdAt: now,
          updatedAt: now,
        });
        await repository.put({
          id: "2",
          category: "a",
          subcategory: "x",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.getAll({
          orderBy: [{ column: "category", direction: "ASC" }],
        });
        expect(results?.length).toBe(2);
        expect(results?.map((r) => r.category)).toEqual(["a", "b"]);
      });

      it("should return undefined when no matches found", async () => {
        const now = new Date().toISOString();
        await repository.put({
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        });

        const results = await repository.query({ category: "nonexistent" });
        expect(results).toBeUndefined();
      });
    });

    describe("queryIndex (covering-index-only reads)", () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("returns rows projected to only the requested columns", async () => {
        await repository.put({
          id: "1",
          category: "a",
          subcategory: "x",
          value: 10,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const rows = await repository.queryIndex({ category: "a" }, { select: ["id", "category"] });
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]).sort()).toEqual(["category", "id"]);
      });

      it("throws when no covering index exists for the criteria column", async () => {
        // `kind` is not in any of the registered indexes
        await expect(
          repository.queryIndex({ kind: "premium" } as any, { select: ["id"] })
        ).rejects.toThrow(/CoveringIndexMissingError|No covering index/);
      });

      it("returns empty array (not undefined) for no matches", async () => {
        const rows = await repository.queryIndex({ category: "missing" }, { select: ["id"] });
        expect(rows).toEqual([]);
      });

      it("honors limit and offset", async () => {
        for (let i = 0; i < 5; i++) {
          await repository.put({
            id: String(i),
            category: "a",
            subcategory: String(i),
            value: i,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        const rows = await repository.queryIndex(
          { category: "a" },
          {
            select: ["id", "subcategory"],
            orderBy: [{ column: "subcategory", direction: "ASC" }],
            limit: 2,
            offset: 1,
          }
        );
        expect(rows).toHaveLength(2);
        expect(rows[0].subcategory).toBe("1");
        expect(rows[1].subcategory).toBe("2");
      });
    });

    describe(`count tests`, () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      const seed = async () => {
        const now = new Date().toISOString();
        await repository.putBulk([
          {
            id: "1",
            category: "electronics",
            subcategory: "phones",
            kind: "premium",
            value: 100,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "2",
            category: "electronics",
            subcategory: "phones",
            kind: "budget",
            value: 200,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "3",
            category: "electronics",
            subcategory: "laptops",
            kind: "premium",
            value: 300,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "4",
            category: "books",
            subcategory: "fiction",
            kind: "premium",
            value: 400,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      };

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should return total count with no criteria", async () => {
        await seed();
        expect(await repository.count()).toBe(4);
      });

      it("should match size() with no criteria", async () => {
        await seed();
        expect(await repository.count()).toBe(await repository.size());
      });

      it("should count with equality on single indexed column", async () => {
        await seed();
        expect(await repository.count({ category: "electronics" })).toBe(3);
        expect(await repository.count({ category: "books" })).toBe(1);
      });

      it("should count with equality on a compound index prefix (covered)", async () => {
        await seed();
        expect(await repository.count({ category: "electronics", subcategory: "phones" })).toBe(2);
      });

      it("should count when criteria mixes indexed and non-indexed columns", async () => {
        // `kind` is not in the indexes configured by the IndexedDb test setup,
        // so this exercises the partial-index narrowing path: narrow on
        // `category`, filter `kind` in JS.
        await seed();
        expect(await repository.count({ category: "electronics", kind: "premium" })).toBe(2);
        expect(await repository.count({ category: "electronics", kind: "budget" })).toBe(1);
      });

      it("should count with comparison operators", async () => {
        await seed();
        expect(await repository.count({ value: { value: 200, operator: "<" } })).toBe(1);
        expect(await repository.count({ value: { value: 200, operator: "<=" } })).toBe(2);
        expect(await repository.count({ value: { value: 200, operator: ">" } })).toBe(2);
        expect(await repository.count({ value: { value: 200, operator: ">=" } })).toBe(3);
      });

      it("should return 0 when no rows match", async () => {
        await seed();
        expect(await repository.count({ category: "nonexistent" })).toBe(0);
      });

      it("should return 0 on empty repository", async () => {
        expect(await repository.count({ category: "electronics" })).toBe(0);
      });
    });

    describe("return value tests with timestamps", () => {
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should return entity with timestamps from put()", async () => {
        const now = new Date().toISOString();
        const entity = {
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        };

        const returned = await repository.put(entity);

        // Verify all fields are returned
        expect(returned).toBeDefined();
        expect(returned.id).toEqual("1");
        expect(returned.category).toEqual("electronics");
        expect(returned.subcategory).toEqual("phones");
        expect(returned.value).toEqual(100);
        expect(returned.createdAt).toBeDefined();
        expect(returned.updatedAt).toBeDefined();
      });

      it("should return entities with timestamps from putBulk()", async () => {
        const now = new Date().toISOString();
        const entities = [
          {
            id: "1",
            category: "electronics",
            subcategory: "phones",
            value: 100,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "2",
            category: "books",
            subcategory: "fiction",
            value: 200,
            createdAt: now,
            updatedAt: now,
          },
        ];

        const returned = await repository.putBulk(entities);

        // Verify all entities are returned with all fields
        expect(returned).toBeDefined();
        expect(returned.length).toEqual(2);

        for (let i = 0; i < entities.length; i++) {
          expect(returned[i].id).toEqual(entities[i].id);
          expect(returned[i].category).toEqual(entities[i].category);
          expect(returned[i].subcategory).toEqual(entities[i].subcategory);
          expect(returned[i].value).toEqual(entities[i].value);
          expect(returned[i].createdAt).toBeDefined();
          expect(returned[i].updatedAt).toBeDefined();
        }
      });

      it("should return updated timestamps when upserting", async () => {
        const now = new Date().toISOString();
        const entity1 = {
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        };

        // First insert
        const returned1 = await repository.put(entity1);
        expect(returned1.value).toEqual(100);

        // Wait a moment to ensure timestamps would differ
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Update with new data
        const later = new Date().toISOString();
        const entity2 = {
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 150,
          createdAt: now, // Keep original created time
          updatedAt: later, // New update time
        };

        const returned2 = await repository.put(entity2);
        expect(returned2.value).toEqual(150);
        expect(returned2.updatedAt).toBeDefined();

        // Verify the update persisted
        const stored = await repository.get({ id: "1" });
        expect(stored?.value).toEqual(150);
      });

      it("should return consistent data between put() result and get()", async () => {
        const now = new Date().toISOString();
        const entity = {
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now,
          updatedAt: now,
        };

        const returned = await repository.put(entity);
        const retrieved = await repository.get({ id: "1" });

        // Verify returned and retrieved match
        expect(retrieved).toBeDefined();
        expect(returned.id).toEqual(retrieved!.id);
        expect(returned.category).toEqual(retrieved!.category);
        expect(returned.subcategory).toEqual(retrieved!.subcategory);
        expect(returned.value).toEqual(retrieved!.value);
        expect(returned.createdAt).toEqual(retrieved!.createdAt);
        expect(returned.updatedAt).toEqual(retrieved!.updatedAt);
      });

      it("should return consistent data between putBulk() results and getAll()", async () => {
        const now = new Date().toISOString();
        const entities = [
          {
            id: "1",
            category: "electronics",
            subcategory: "phones",
            value: 100,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "2",
            category: "books",
            subcategory: "fiction",
            value: 200,
            createdAt: now,
            updatedAt: now,
          },
        ];

        const returned = await repository.putBulk(entities);
        const retrieved = await repository.getAll();

        // Verify returned and retrieved match
        expect(retrieved).toBeDefined();
        expect(returned.length).toEqual(retrieved!.length);

        // Sort both arrays by id for comparison
        const sortedReturned = returned.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
        const sortedRetrieved = retrieved!.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));

        for (let i = 0; i < sortedReturned.length; i++) {
          expect(sortedReturned[i].id).toEqual(sortedRetrieved[i].id);
          expect(sortedReturned[i].category).toEqual(sortedRetrieved[i].category);
          expect(sortedReturned[i].subcategory).toEqual(sortedRetrieved[i].subcategory);
          expect(sortedReturned[i].value).toEqual(sortedRetrieved[i].value);
          expect(sortedReturned[i].createdAt).toEqual(sortedRetrieved[i].createdAt);
          expect(sortedReturned[i].updatedAt).toEqual(sortedRetrieved[i].updatedAt);
        }
      });
    });

    describe("cursor pagination on single-PK schema", () => {
      // SearchSchema has a single-column primary key (`id`). This block
      // exercises the simple-keyset pushdown path in BaseTabularStorage and
      // the SQL row-value pushdown in BaseSqlTabularStorage; both rely on a
      // single inequality on the primary key, which is the most common case
      // in practice.
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      const seedRows = async (n: number): Promise<void> => {
        const now = new Date().toISOString();
        const rows = Array.from({ length: n }, (_, i) => ({
          // Zero-padded so lexicographic order matches numeric order.
          id: `id-${String(i).padStart(3, "0")}`,
          category: i % 2 === 0 ? "even" : "odd",
          subcategory: "s",
          value: i,
          createdAt: now,
          updatedAt: now,
        }));
        await repository.putBulk(rows);
      };

      it("iterates the entire table by following nextCursor", async () => {
        await seedRows(7);
        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({ limit: 3, cursor });
          for (const row of page.items) seen.push(row.id);
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual([
          "id-000",
          "id-001",
          "id-002",
          "id-003",
          "id-004",
          "id-005",
          "id-006",
        ]);
      });

      it("is stable under concurrent inserts that sort before the cursor", async () => {
        await seedRows(5);
        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.id)).toEqual(["id-000", "id-001"]);

        const now = new Date().toISOString();
        await repository.put({
          id: "id--early",
          category: "x",
          subcategory: "s",
          value: -1,
          createdAt: now,
          updatedAt: now,
        });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((r) => r.id)).toEqual(["id-002", "id-003"]);
      });

      it("surfaces inserts that sort after the cursor", async () => {
        await seedRows(5);
        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.id)).toEqual(["id-000", "id-001"]);

        const now = new Date().toISOString();
        // Insert a row that sorts strictly after id-001 but before id-002:
        // "id-001a" lies between "id-001" and "id-002" lexicographically.
        await repository.put({
          id: "id-001a",
          category: "x",
          subcategory: "s",
          value: 99,
          createdAt: now,
          updatedAt: now,
        });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((r) => r.id)).toEqual(["id-001a", "id-002"]);
      });

      it("paginates filtered results via queryPage", async () => {
        await seedRows(8);
        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.queryPage({ category: "even" }, { limit: 2, cursor });
          for (const row of page.items) seen.push(row.id);
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(["id-000", "id-002", "id-004", "id-006"]);
      });

      it("supports DESC ordering via the cursor", async () => {
        await seedRows(5);
        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 2,
            cursor,
            orderBy: [{ column: "id", direction: "DESC" }],
          });
          for (const row of page.items) seen.push(row.id);
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(["id-004", "id-003", "id-002", "id-001", "id-000"]);
      });

      it("paginates by a non-PK orderBy with primary key as tiebreaker", async () => {
        // Many rows share `category=even` / `category=odd`; the PK tiebreaker
        // is what keeps iteration deterministic when sort columns collide.
        await seedRows(8);
        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 3,
            cursor,
            orderBy: [{ column: "category", direction: "ASC" }],
          });
          for (const row of page.items) seen.push(row.id);
          cursor = page.nextCursor;
        } while (cursor);
        // All four `even` rows precede all four `odd` rows; within each group
        // the ids are visited in PK order.
        expect(seen).toEqual([
          "id-000",
          "id-002",
          "id-004",
          "id-006",
          "id-001",
          "id-003",
          "id-005",
          "id-007",
        ]);
      });

      it("paginates with mixed ASC/DESC orderBy", async () => {
        // Exercises the OR-of-AND keyset expansion in `buildKeysetWhere`:
        // a single-column comparison can't express "category DESC, value ASC"
        // when the cursor straddles a category boundary, so the SQL backend
        // must emit `(category < ?) OR (category = ? AND value > ?) OR ...`.
        await seedRows(8);
        const seen: Array<{ id: string; category: string; value: number }> = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 3,
            cursor,
            orderBy: [
              { column: "category", direction: "DESC" },
              { column: "value", direction: "ASC" },
            ],
          });
          for (const row of page.items) {
            seen.push({ id: row.id, category: row.category, value: row.value });
          }
          cursor = page.nextCursor;
        } while (cursor);
        // category DESC: "odd" (1,3,5,7) before "even" (0,2,4,6); within each
        // the value ASC tiebreaker dictates 1<3<5<7 then 0<2<4<6.
        expect(seen.map((r) => r.id)).toEqual([
          "id-001",
          "id-003",
          "id-005",
          "id-007",
          "id-000",
          "id-002",
          "id-004",
          "id-006",
        ]);
      });

      it("paginates by a nullable column with NULLs ordering correctly", async () => {
        // `kind` is optional in SearchSchema, so some rows have NULL.
        // ASC orders NULLs first (matches in-memory comparator + the
        // `NULLS FIRST` clauses in SQL); resuming through the NULL run
        // and into the non-null tail must not skip or duplicate.
        const now = new Date().toISOString();
        const rows = [
          { id: "n1", category: "c", subcategory: "s", value: 1, createdAt: now, updatedAt: now },
          { id: "n2", category: "c", subcategory: "s", value: 2, createdAt: now, updatedAt: now },
          {
            id: "k1",
            category: "c",
            subcategory: "s",
            kind: "alpha",
            value: 3,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "k2",
            category: "c",
            subcategory: "s",
            kind: "beta",
            value: 4,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "k3",
            category: "c",
            subcategory: "s",
            kind: "gamma",
            value: 5,
            createdAt: now,
            updatedAt: now,
          },
        ];
        await repository.putBulk(rows);

        const seen: Array<{ id: string; kind: string | undefined }> = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 2,
            cursor,
            orderBy: [{ column: "kind", direction: "ASC" }],
          });
          for (const row of page.items) {
            seen.push({ id: row.id, kind: row.kind });
          }
          cursor = page.nextCursor;
        } while (cursor);

        // First two slots: the two NULL-kind rows in PK order. Then the
        // three named rows in alphabetic order.
        const nullIds = seen.filter((r) => r.kind == null).map((r) => r.id);
        const namedIds = seen.filter((r) => r.kind != null).map((r) => r.id);
        expect(nullIds.sort()).toEqual(["n1", "n2"]);
        expect(namedIds).toEqual(["k1", "k2", "k3"]);
        // First two seen entries must be the NULL run.
        expect(seen.slice(0, 2).every((r) => r.kind == null)).toBe(true);
      });

      it("paginates compound (nullable, non-null) ASC orderBy across the NULL/non-null boundary", async () => {
        // Exercises the SQL keyset's NULL-aware predicates on a compound
        // ordering where the leading column is nullable. Specifically:
        //   - When the cursor is parked on a NULL-kind row, the next-page
        //     filter must be `(kind IS NOT NULL) OR (kind IS NULL AND value > ?)`
        //     (the strict NULL → IS NOT NULL branch plus the tiebreaker AND).
        //   - When the cursor is parked on a non-null-kind row, the filter
        //     must be `(kind > ?) OR (kind = ? AND value > ?)` (the regular
        //     OR-of-AND with no NULL gymnastics).
        // Both branches need to produce identical results from the same
        // table iteration, regardless of which row the page boundary lands on.
        const now = new Date().toISOString();
        const rows = [
          // Two NULL-kind rows differing only by value (force the in-NULL-run
          // tiebreaker case).
          { id: "n1", category: "c", subcategory: "s", value: 1, createdAt: now, updatedAt: now },
          { id: "n2", category: "c", subcategory: "s", value: 3, createdAt: now, updatedAt: now },
          // Three named-kind rows.
          {
            id: "k1",
            category: "c",
            subcategory: "s",
            kind: "alpha",
            value: 10,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "k2",
            category: "c",
            subcategory: "s",
            kind: "alpha",
            value: 20,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "k3",
            category: "c",
            subcategory: "s",
            kind: "beta",
            value: 5,
            createdAt: now,
            updatedAt: now,
          },
        ];
        await repository.putBulk(rows);

        // Iterate one row per page so every cursor lands on a row whose
        // keyset position matters for the next call. With NULLs-first ASC,
        // the order is: (null, 1) (null, 3) (alpha, 10) (alpha, 20) (beta, 5).
        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 1,
            cursor,
            orderBy: [
              { column: "kind", direction: "ASC" },
              { column: "value", direction: "ASC" },
            ],
          });
          for (const row of page.items) seen.push(row.id);
          if (page.items.length === 0) break;
          cursor = page.nextCursor;
        } while (cursor);

        expect(seen).toEqual(["n1", "n2", "k1", "k2", "k3"]);
      });

      it("paginates compound (nullable DESC, non-null ASC) — mixed direction with NULLs trailing", async () => {
        // Exercises the mixed ASC/DESC keyset expansion on a nullable
        // leading column. With kind DESC + NULLs-last, named rows come
        // first (largest kind to smallest), then NULL rows ordered by the
        // value ASC tiebreaker. The keyset must:
        //   - On a non-null cursor row: emit `(kind < ? OR kind IS NULL)
        //     AND ...` — DESC NULLs-last means anything smaller than the
        //     cursor's kind, plus the NULL trailer.
        //   - On a NULL cursor row: emit `(1=0) OR (kind IS NULL AND value > ?)` —
        //     no rows come after the NULL run except more-advanced NULL rows
        //     (tiebreaker on value ASC).
        const now = new Date().toISOString();
        const rows = [
          {
            id: "k1",
            category: "c",
            subcategory: "s",
            kind: "alpha",
            value: 1,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "k2",
            category: "c",
            subcategory: "s",
            kind: "beta",
            value: 1,
            createdAt: now,
            updatedAt: now,
          },
          { id: "n1", category: "c", subcategory: "s", value: 1, createdAt: now, updatedAt: now },
          { id: "n2", category: "c", subcategory: "s", value: 2, createdAt: now, updatedAt: now },
        ];
        await repository.putBulk(rows);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 1,
            cursor,
            orderBy: [
              { column: "kind", direction: "DESC" },
              { column: "value", direction: "ASC" },
            ],
          });
          for (const row of page.items) seen.push(row.id);
          if (page.items.length === 0) break;
          cursor = page.nextCursor;
        } while (cursor);

        // beta > alpha (DESC); NULLs trail. Within NULL run: value 1 then 2.
        expect(seen).toEqual(["k2", "k1", "n1", "n2"]);
      });

      it("paginates compound (non-null ASC, nullable ASC) — non-leading nullable column", async () => {
        // The NULL-handling branches in `buildKeysetWhere` apply at any
        // column position, not just the leading one. Here `kind` is at the
        // tiebreaker position; equality on the prior `category` column +
        // strict NULL/non-NULL on `kind` must still produce the right rows.
        const now = new Date().toISOString();
        const rows = [
          // Same category, mix of NULL and non-NULL kinds.
          {
            id: "a1",
            category: "x",
            subcategory: "s",
            value: 1,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "a2",
            category: "x",
            subcategory: "s",
            kind: "first",
            value: 2,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "a3",
            category: "x",
            subcategory: "s",
            kind: "second",
            value: 3,
            createdAt: now,
            updatedAt: now,
          },
          // Different category to confirm equality on category is honoured.
          {
            id: "b1",
            category: "y",
            subcategory: "s",
            kind: "first",
            value: 10,
            createdAt: now,
            updatedAt: now,
          },
        ];
        await repository.putBulk(rows);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 1,
            cursor,
            orderBy: [
              { column: "category", direction: "ASC" },
              { column: "kind", direction: "ASC" },
            ],
          });
          for (const row of page.items) seen.push(row.id);
          if (page.items.length === 0) break;
          cursor = page.nextCursor;
        } while (cursor);

        // category=x rows first (NULL-kind first via NULLs-first ASC, then
        // first, then second), then category=y row.
        expect(seen).toEqual(["a1", "a2", "a3", "b1"]);
      });

      it("returns no rows when DESC cursor is parked on a NULL value with no further NULL tiebreaker rows", async () => {
        // DESC NULLs-last + cursor on a NULL leading column should yield
        // an empty page when there's no more-advanced row in the NULL run.
        // The Supabase implementation short-circuits this without a
        // round-trip; the SQL backends emit a `(1 = 0) OR ...` predicate
        // that filters everything out. Either way: empty next page.
        const now = new Date().toISOString();
        const rows = [
          {
            id: "k1",
            category: "c",
            subcategory: "s",
            kind: "alpha",
            value: 1,
            createdAt: now,
            updatedAt: now,
          },
          // Single NULL-kind row. DESC NULLs-last places it at the end;
          // there's nothing after it.
          { id: "n1", category: "c", subcategory: "s", value: 1, createdAt: now, updatedAt: now },
        ];
        await repository.putBulk(rows);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({
            limit: 1,
            cursor,
            orderBy: [{ column: "kind", direction: "DESC" }],
          });
          for (const row of page.items) seen.push(row.id);
          if (page.items.length === 0) break;
          cursor = page.nextCursor;
        } while (cursor);

        // k1 (kind=alpha) comes before n1 (NULL trailer). After n1 the
        // DESC keyset on a NULL leading value must return empty.
        expect(seen).toEqual(["k1", "n1"]);
      });

      it("emits a non-undefined nextCursor when the page is full and the next call returns empty", async () => {
        // The contract documents that a non-undefined nextCursor doesn't
        // guarantee more rows; this pins the behaviour at the boundary
        // where row count equals limit exactly.
        await seedRows(2);
        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.length).toBe(2);
        expect(firstPage.nextCursor).toBeDefined();
        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.length).toBe(0);
        expect(secondPage.nextCursor).toBeUndefined();
      });

      it("supports two iterators advancing independently over the same store", async () => {
        // Each iterator owns its cursor; one falling behind or skipping a
        // page must not affect the other. (Cursors are pure values, so
        // this should be trivially true — but the test guards against
        // any backend that secretly relies on per-instance state.)
        await seedRows(6);
        const seenA: string[] = [];
        const seenB: string[] = [];
        let cursorA: PageCursor | undefined;
        let cursorB: PageCursor | undefined;
        for (let step = 0; step < 4; step++) {
          const pageA = await repository.getPage({ limit: 2, cursor: cursorA });
          const pageB = await repository.getPage({ limit: 2, cursor: cursorB });
          for (const r of pageA.items) seenA.push(r.id);
          for (const r of pageB.items) seenB.push(r.id);
          cursorA = pageA.nextCursor;
          cursorB = pageB.nextCursor;
          if (!cursorA && !cursorB) break;
        }
        expect(seenA).toEqual(seenB);
        expect(seenA).toEqual(["id-000", "id-001", "id-002", "id-003", "id-004", "id-005"]);
      });

      it("rejects a cursor whose orderBy shape doesn't match the request", async () => {
        // Same arity, different column — easy to do by accident if a
        // caller switches sort key mid-iteration. The cursor's column
        // names must be checked, not just its arity.
        await seedRows(3);
        const firstPage = await repository.getPage({
          limit: 1,
          orderBy: [{ column: "value", direction: "ASC" }],
        });
        expect(firstPage.nextCursor).toBeDefined();
        await expect(
          repository.getPage({
            limit: 1,
            cursor: firstPage.nextCursor,
            orderBy: [{ column: "category", direction: "ASC" }],
          })
        ).rejects.toThrow();
      });

      it("rejects non-integer and non-positive limits", async () => {
        await seedRows(1);
        await expect(repository.getPage({ limit: 0 })).rejects.toThrow();
        await expect(repository.getPage({ limit: -1 })).rejects.toThrow();
        await expect(repository.getPage({ limit: 1.5 })).rejects.toThrow();
      });

      it("round-trips cursor values through SQL/PostgREST escaping for thorny strings", async () => {
        // Stresses the encoding/escaping pipeline end-to-end. SQL backends
        // bind values as parameters so quoting is trivial there; the value
        // for Supabase travels through PostgREST's `.or()` filter grammar
        // (which uses `,`, `.`, `(`, `)`, `:`, `"` as syntax delimiters)
        // and back through the mock parser's unescape. Anything that
        // breaks that round-trip surfaces as a missing or duplicate row.
        const now = new Date().toISOString();
        const thornyIds = [
          "id,with,commas",
          'id"with"quotes',
          "id\\with\\backslashes",
          "id.with.periods",
          "id(with)parens",
          'id"and\\both,plus.everything(else)',
        ];
        const rows = thornyIds.map((id) => ({
          id,
          category: "c",
          subcategory: "s",
          value: 1,
          createdAt: now,
          updatedAt: now,
        }));
        await repository.putBulk(rows);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({ limit: 2, cursor });
          for (const row of page.items) seen.push(row.id);
          if (page.items.length === 0) break;
          cursor = page.nextCursor;
        } while (cursor);

        // Order is by primary key (id) ASC; the exact ordering depends on
        // string collation but every row must appear exactly once.
        expect(seen.sort()).toEqual([...thornyIds].sort());
      });
    });

    describe("getBulk(keys) on single-PK schema", () => {
      // SearchSchema has a single-column primary key (`id`). This block
      // exercises the SQL backends' single-column branch — `WHERE pk IN
      // (?,?,...)` for SQLite / `WHERE pk IN ($1,$2,...)` for Postgres —
      // which is structurally distinct from the compound-PK row-value
      // form covered above and otherwise has no test coverage.
      let repository: ITabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createSearchableRepository!();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      const seed = async (): Promise<void> => {
        const now = new Date().toISOString();
        await repository.putBulk([
          { id: "a", category: "x", subcategory: "s", value: 1, createdAt: now, updatedAt: now },
          { id: "b", category: "x", subcategory: "s", value: 2, createdAt: now, updatedAt: now },
          { id: "c", category: "y", subcategory: "s", value: 3, createdAt: now, updatedAt: now },
        ]);
      };

      it("returns empty array for empty input without throwing", async () => {
        const result = await repository.getBulk([]);
        expect(result).toEqual([]);
      });

      it("returns empty array when no keys exist", async () => {
        await seed();
        const result = await repository.getBulk([{ id: "missing-1" }, { id: "missing-2" }]);
        expect(result).toEqual([]);
      });

      it("returns all entities when every key exists", async () => {
        await seed();
        const result = await repository.getBulk([{ id: "a" }, { id: "b" }, { id: "c" }]);
        expect(result.length).toBe(3);
        const byId = new Map(result.map((r) => [r.id, r]));
        expect(byId.get("a")?.value).toBe(1);
        expect(byId.get("b")?.value).toBe(2);
        expect(byId.get("c")?.value).toBe(3);
      });

      it("returns only the found subset when some keys are missing", async () => {
        await seed();
        const result = await repository.getBulk([{ id: "a" }, { id: "missing" }, { id: "c" }]);
        expect(result.length).toBe(2);
        const ids = result.map((r) => r.id).sort();
        expect(ids).toEqual(["a", "c"]);
      });

      it("returns full entity rows (non-PK fields included)", async () => {
        await seed();
        const result = await repository.getBulk([{ id: "b" }]);
        expect(result.length).toBe(1);
        expect(result[0].category).toBe("x");
        expect(result[0].value).toBe(2);
      });

      it("emits a getBulk event with the keys and the found entities", async () => {
        await seed();
        const seen: Array<{ keys: any; found: any }> = [];
        repository.on("getBulk", (keys, entities) => {
          seen.push({ keys, found: entities });
        });
        const keys = [{ id: "a" }, { id: "missing" }];
        await repository.getBulk(keys);
        expect(seen.length).toBe(1);
        expect(seen[0].keys).toEqual(keys);
        expect(seen[0].found.length).toBe(1);
        expect(seen[0].found[0].id).toBe("a");
      });
    });
  }

  if (createAllTypesRepository) {
    describe("data type coverage", () => {
      type AllTypesRecord = FromSchema<typeof AllTypesSchema>;
      let repository: ITabularStorage<typeof AllTypesSchema, typeof AllTypesPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createAllTypesRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should store and retrieve all data types correctly", async () => {
        const entity: AllTypesRecord = {
          id: "test-1",
          textField: "Hello, World!",
          numberField: 3.14159,
          integerField: 42,
          booleanField: true,
          arrayField: ["item1", "item2", "item3"],
          objectField: {
            key1: "value1",
            key2: 123,
          },
          nestedObjectField: {
            level1: {
              level2: {
                nested: "value",
                count: 456,
              },
            },
          },
        };

        // Store the entity
        const stored = await repository.put(entity);
        expect(stored).toBeDefined();

        // Retrieve the entity
        const retrieved = await repository.get({ id: "test-1" });
        expect(retrieved).toBeDefined();

        // Verify all data types are preserved correctly
        expect(retrieved?.id).toBe("test-1");
        expect(retrieved?.textField).toBe("Hello, World!");
        expect(retrieved?.numberField).toBe(3.14159);
        expect(retrieved?.integerField).toBe(42);
        expect(retrieved?.booleanField).toBe(true);
        expect(retrieved?.arrayField).toEqual(["item1", "item2", "item3"]);
        expect(retrieved?.objectField).toEqual({
          key1: "value1",
          key2: 123,
        });
        expect(retrieved?.nestedObjectField).toEqual({
          level1: {
            level2: {
              nested: "value",
              count: 456,
            },
          },
        });
      });

      it("should handle boolean false correctly", async () => {
        const entity: AllTypesRecord = {
          id: "test-false",
          textField: "Test",
          numberField: 0,
          integerField: 0,
          booleanField: false,
          arrayField: [],
          objectField: {},
          nestedObjectField: {},
        };

        await repository.put(entity);
        const retrieved = await repository.get({ id: "test-false" });

        expect(retrieved?.booleanField).toBe(false);
        expect(retrieved?.arrayField).toEqual([]);
        expect(retrieved?.objectField).toEqual({});
      });

      it("should handle complex arrays and objects", async () => {
        const entity: AllTypesRecord = {
          id: "test-complex",
          textField: "Complex data",
          numberField: -123.456,
          integerField: -999,
          booleanField: true,
          arrayField: ["string1", "string2", "string with spaces", ""],
          objectField: {
            stringProp: "value",
            numberProp: 789,
            booleanProp: true,
            arrayProp: [1, 2, 3],
            nestedProp: {
              deep: "nested value",
            },
          },
          nestedObjectField: {
            metadata: {
              tags: ["tag1", "tag2"],
              count: 10,
            },
            config: {
              enabled: true,
              threshold: 0.5,
            },
          },
        };

        await repository.put(entity);
        const retrieved = await repository.get({ id: "test-complex" });

        expect(retrieved?.arrayField).toEqual(["string1", "string2", "string with spaces", ""]);
        expect(retrieved?.objectField).toEqual({
          stringProp: "value",
          numberProp: 789,
          booleanProp: true,
          arrayProp: [1, 2, 3],
          nestedProp: {
            deep: "nested value",
          },
        });
        expect(retrieved?.nestedObjectField).toEqual({
          metadata: {
            tags: ["tag1", "tag2"],
            count: 10,
          },
          config: {
            enabled: true,
            threshold: 0.5,
          },
        });
      });

      it("should handle bulk operations with all data types", async () => {
        const entities: AllTypesRecord[] = [
          {
            id: "bulk-1",
            textField: "First",
            numberField: 1.1,
            integerField: 1,
            booleanField: true,
            arrayField: ["a"],
            objectField: { x: 1 },
            nestedObjectField: {},
          },
          {
            id: "bulk-2",
            textField: "Second",
            numberField: 2.2,
            integerField: 2,
            booleanField: false,
            arrayField: ["b", "c"],
            objectField: { y: 2 },
            nestedObjectField: { nested: "value" },
          },
        ];

        await repository.putBulk(entities);

        const retrieved1 = await repository.get({ id: "bulk-1" });
        const retrieved2 = await repository.get({ id: "bulk-2" });

        expect(retrieved1?.booleanField).toBe(true);
        expect(retrieved2?.booleanField).toBe(false);
        expect(retrieved1?.arrayField).toEqual(["a"]);
        expect(retrieved2?.arrayField).toEqual(["b", "c"]);
        expect(retrieved1?.objectField).toEqual({ x: 1 });
        expect(retrieved2?.nestedObjectField).toEqual({ nested: "value" });
      });
    });
  }

  // Iteration methods tests
  describe("iteration methods", () => {
    let repository: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(async () => {
      repository = await createCompoundPkRepository();
      await repository.setupDatabase?.();
    });

    afterEach(async () => {
      await repository.deleteAll();
      repository.destroy();
    });

    describe("getOffsetPage", () => {
      it("should return undefined for empty table", async () => {
        const result = await repository.getOffsetPage(0, 10);
        expect(result).toBeUndefined();
      });

      it("should fetch a full page of records", async () => {
        // Insert 5 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
          { name: "key4", type: "type4", option: "value4", success: false },
          { name: "key5", type: "type5", option: "value5", success: true },
        ];
        await repository.putBulk(entities);

        const result = await repository.getOffsetPage(0, 5);
        expect(result).toBeDefined();
        expect(result!.length).toBe(5);
      });

      it("should fetch a partial page when less records available", async () => {
        // Insert 3 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
        ];
        await repository.putBulk(entities);

        const result = await repository.getOffsetPage(0, 10);
        expect(result).toBeDefined();
        expect(result!.length).toBe(3);
      });

      it("should handle offset correctly", async () => {
        // Insert 5 records out of order to ensure deterministic pagination
        const entities = [
          { name: "key3", type: "type3", option: "value3", success: true },
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key5", type: "type5", option: "value5", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key4", type: "type4", option: "value4", success: false },
        ];
        await repository.putBulk(entities);

        const result = await repository.getOffsetPage(2, 2);
        expect(result).toBeDefined();
        expect(result!.length).toBe(2);
        // Assuming deterministic ordering by primary key (name, then type),
        // the sorted order is key1, key2, key3, key4, key5.
        // With offset=2 and limit=2, we expect key3 and key4.
        expect(result![0].name).toBe("key3");
        expect(result![0].type).toBe("type3");
        expect(result![1].name).toBe("key4");
        expect(result![1].type).toBe("type4");
      });

      it("should return undefined when offset is beyond end", async () => {
        // Insert 3 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
        ];
        await repository.putBulk(entities);

        const result = await repository.getOffsetPage(10, 5);
        expect(result).toBeUndefined();
      });

      it("should handle limit of 1", async () => {
        // Insert 3 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
        ];
        await repository.putBulk(entities);

        const result = await repository.getOffsetPage(0, 1);
        expect(result).toBeDefined();
        expect(result!.length).toBe(1);
      });
    });

    describe("getBulk(keys)", () => {
      const seed = [
        { name: "key1", type: "type1", option: "value1", success: true },
        { name: "key2", type: "type2", option: "value2", success: false },
        { name: "key3", type: "type3", option: "value3", success: true },
      ];

      it("returns an empty array for empty input without throwing", async () => {
        const result = await repository.getBulk([]);
        expect(result).toEqual([]);
      });

      it("returns an empty array when no keys exist", async () => {
        await repository.putBulk(seed);
        const result = await repository.getBulk([
          { name: "missing", type: "missing" },
          { name: "also-missing", type: "x" },
        ]);
        expect(result).toEqual([]);
      });

      it("returns all entities when every key exists", async () => {
        await repository.putBulk(seed);
        const result = await repository.getBulk([
          { name: "key1", type: "type1" },
          { name: "key2", type: "type2" },
          { name: "key3", type: "type3" },
        ]);
        expect(result.length).toBe(3);
        const byName = new Map(result.map((r) => [r.name, r]));
        expect(byName.get("key1")?.option).toBe("value1");
        expect(byName.get("key2")?.option).toBe("value2");
        expect(byName.get("key3")?.option).toBe("value3");
      });

      it("returns only the found subset when some keys are missing", async () => {
        await repository.putBulk(seed);
        const result = await repository.getBulk([
          { name: "key1", type: "type1" },
          { name: "missing", type: "missing" },
          { name: "key3", type: "type3" },
        ]);
        expect(result.length).toBe(2);
        const names = result.map((r) => r.name).sort();
        expect(names).toEqual(["key1", "key3"]);
      });

      it("returns full entity rows (non-PK fields included)", async () => {
        await repository.putBulk(seed);
        const result = await repository.getBulk([{ name: "key2", type: "type2" }]);
        expect(result.length).toBe(1);
        expect(result[0].option).toBe("value2");
        expect(!!result[0].success).toBe(false);
      });

      it("emits a getBulk event with the keys and the found entities", async () => {
        await repository.putBulk(seed);
        const seen: Array<{ keys: any; found: any }> = [];
        repository.on("getBulk", (keys, entities) => {
          seen.push({ keys, found: entities });
        });
        const keys = [
          { name: "key1", type: "type1" },
          { name: "missing", type: "missing" },
        ];
        await repository.getBulk(keys);
        expect(seen.length).toBe(1);
        expect(seen[0].keys).toEqual(keys);
        expect(seen[0].found.length).toBe(1);
        expect(seen[0].found[0].name).toBe("key1");
      });
    });

    describe("records", () => {
      it("should yield all records one by one", async () => {
        // Insert 5 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
          { name: "key4", type: "type4", option: "value4", success: false },
          { name: "key5", type: "type5", option: "value5", success: true },
        ];
        await repository.putBulk(entities);

        const collected: any[] = [];
        for await (const record of repository.records(2)) {
          collected.push(record);
        }

        expect(collected.length).toBe(5);
      });

      it("should handle empty table", async () => {
        const collected: any[] = [];
        for await (const record of repository.records()) {
          collected.push(record);
        }

        expect(collected.length).toBe(0);
      });

      it("should use custom page size", async () => {
        // Insert 10 records
        const entities = Array.from({ length: 10 }, (_, i) => ({
          name: `key${i}`,
          type: `type${i}`,
          option: `value${i}`,
          success: i % 2 === 0,
        }));
        await repository.putBulk(entities);

        const collected: any[] = [];
        for await (const record of repository.records(3)) {
          collected.push(record);
        }

        expect(collected.length).toBe(10);
      });

      it("should yield all records with correct properties", async () => {
        // Insert 3 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
        ];
        await repository.putBulk(entities);

        const collected: any[] = [];
        for await (const record of repository.records()) {
          collected.push(record);
        }

        expect(collected.length).toBe(3);
        // Verify records have expected structure
        for (const record of collected) {
          expect(record).toHaveProperty("name");
          expect(record).toHaveProperty("type");
          expect(record).toHaveProperty("option");
          expect(record).toHaveProperty("success");
        }
      });
    });

    describe("pages", () => {
      it("should yield all pages", async () => {
        // Insert 10 records
        const entities = Array.from({ length: 10 }, (_, i) => ({
          name: `key${i}`,
          type: `type${i}`,
          option: `value${i}`,
          success: i % 2 === 0,
        }));
        await repository.putBulk(entities);

        const pages: any[][] = [];
        for await (const page of repository.pages(3)) {
          pages.push(page);
        }

        // With pageSize=3 and 10 records: 3, 3, 3, 1 = 4 pages
        expect(pages.length).toBe(4);
        expect(pages[0].length).toBe(3);
        expect(pages[1].length).toBe(3);
        expect(pages[2].length).toBe(3);
        expect(pages[3].length).toBe(1);

        // Verify total records
        const totalRecords = pages.reduce((sum, page) => sum + page.length, 0);
        expect(totalRecords).toBe(10);
      });

      it("should handle empty table", async () => {
        const pages: any[][] = [];
        for await (const page of repository.pages(5)) {
          pages.push(page);
        }

        expect(pages.length).toBe(0);
      });

      it("should yield single page when all records fit", async () => {
        // Insert 3 records
        const entities = [
          { name: "key1", type: "type1", option: "value1", success: true },
          { name: "key2", type: "type2", option: "value2", success: false },
          { name: "key3", type: "type3", option: "value3", success: true },
        ];
        await repository.putBulk(entities);

        const pages: any[][] = [];
        for await (const page of repository.pages(10)) {
          pages.push(page);
        }

        expect(pages.length).toBe(1);
        expect(pages[0].length).toBe(3);
      });

      it("should yield exact pages when records divide evenly", async () => {
        // Insert 9 records
        const entities = Array.from({ length: 9 }, (_, i) => ({
          name: `key${i}`,
          type: `type${i}`,
          option: `value${i}`,
          success: i % 2 === 0,
        }));
        await repository.putBulk(entities);

        const pages: any[][] = [];
        for await (const page of repository.pages(3)) {
          pages.push(page);
        }

        // With pageSize=3 and 9 records: 3, 3, 3 = 3 pages
        expect(pages.length).toBe(3);
        expect(pages[0].length).toBe(3);
        expect(pages[1].length).toBe(3);
        expect(pages[2].length).toBe(3);
      });
    });

    describe("getPage (cursor-based)", () => {
      it("should return empty page with no cursor for empty table", async () => {
        const page = await repository.getPage();
        expect(page.items.length).toBe(0);
        expect(page.nextCursor).toBeUndefined();
      });

      it("should iterate all rows by following nextCursor", async () => {
        // Insert keys in shuffled order to verify ordering is by PK, not insert order.
        const entities = [
          { name: "key3", type: "type3", option: "v3", success: true },
          { name: "key1", type: "type1", option: "v1", success: true },
          { name: "key5", type: "type5", option: "v5", success: false },
          { name: "key2", type: "type2", option: "v2", success: false },
          { name: "key4", type: "type4", option: "v4", success: true },
        ];
        await repository.putBulk(entities);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        do {
          const page = await repository.getPage({ limit: 2, cursor });
          for (const row of page.items) seen.push(row.name);
          cursor = page.nextCursor;
        } while (cursor);

        expect(seen).toEqual(["key1", "key2", "key3", "key4", "key5"]);
      });

      it("should signal end-of-iteration with undefined nextCursor on partial page", async () => {
        await repository.putBulk([
          { name: "a", type: "t", option: "v", success: true },
          { name: "b", type: "t", option: "v", success: true },
          { name: "c", type: "t", option: "v", success: true },
        ]);

        const page = await repository.getPage({ limit: 10 });
        expect(page.items.length).toBe(3);
        expect(page.nextCursor).toBeUndefined();
      });

      it("should ignore inserts that sort before the cursor", async () => {
        // The motivating case for keyset paging: with offset paging, inserting
        // a row before the current scan position shifts everything by one so
        // the next page re-emits a row. With cursor paging the cursor anchors
        // to a specific row, so we resume cleanly after it.
        const initial = Array.from({ length: 5 }, (_, i) => ({
          name: `key${i}`,
          type: "t",
          option: `v${i}`,
          success: true,
        }));
        await repository.putBulk(initial);

        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.name)).toEqual(["key0", "key1"]);

        // Concurrent insert that sorts before the cursor ("aaa" < "key2").
        await repository.put({ name: "aaa", type: "t", option: "v", success: true });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        // Cursor resumes after key1; "aaa" sorts earlier so it must not
        // appear, and we must not skip key2.
        expect(secondPage.items.map((r) => r.name)).toEqual(["key2", "key3"]);
      });

      it("should surface inserts that sort after the cursor in subsequent pages", async () => {
        // Symmetry check: a row inserted at a position the iteration hasn't
        // reached yet should appear in the page that covers that position.
        // (Offset paging would also "see" it but at the wrong slot.)
        await repository.putBulk([
          { name: "key0", type: "t", option: "v0", success: true },
          { name: "key1", type: "t", option: "v1", success: true },
          { name: "key3", type: "t", option: "v3", success: true },
          { name: "key5", type: "t", option: "v5", success: true },
        ]);

        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.name)).toEqual(["key0", "key1"]);

        // Insert a row that lives between key1 and key3 — i.e. strictly
        // after the cursor. It should show up on the next page.
        await repository.put({ name: "key2", type: "t", option: "v2", success: true });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((r) => r.name)).toEqual(["key2", "key3"]);

        const thirdPage = await repository.getPage({
          limit: 2,
          cursor: secondPage.nextCursor,
        });
        expect(thirdPage.items.map((r) => r.name)).toEqual(["key5"]);
      });

      it("should be stable when rows past the cursor are deleted", async () => {
        const initial = Array.from({ length: 6 }, (_, i) => ({
          name: `k${i}`,
          type: "t",
          option: `v${i}`,
          success: true,
        }));
        await repository.putBulk(initial);

        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.name)).toEqual(["k0", "k1"]);

        // Delete a row in the unread tail. It must simply be absent rather
        // than perturbing offsets.
        await repository.delete({ name: "k3", type: "t" });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((r) => r.name)).toEqual(["k2", "k4"]);
      });

      it("should be unaffected by deleting rows already returned", async () => {
        // Deleting an already-yielded row must not cause the next page to
        // shift backward. The cursor is a fixed sort-key position, not an
        // offset.
        const initial = Array.from({ length: 6 }, (_, i) => ({
          name: `k${i}`,
          type: "t",
          option: `v${i}`,
          success: true,
        }));
        await repository.putBulk(initial);

        const firstPage = await repository.getPage({ limit: 2 });
        expect(firstPage.items.map((r) => r.name)).toEqual(["k0", "k1"]);

        await repository.delete({ name: "k0", type: "t" });
        await repository.delete({ name: "k1", type: "t" });

        const secondPage = await repository.getPage({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((r) => r.name)).toEqual(["k2", "k3"]);
      });

      it("should tolerate concurrent inserts and deletes during iteration", async () => {
        const initial = Array.from({ length: 6 }, (_, i) => ({
          name: `m${i}`,
          type: "t",
          option: `v${i}`,
          success: true,
        }));
        await repository.putBulk(initial);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        let pageCount = 0;
        do {
          const page = await repository.getPage({ limit: 2, cursor });
          for (const row of page.items) seen.push(row.name);
          cursor = page.nextCursor;
          pageCount++;
          if (pageCount === 1) {
            // After page 1: insert one row before and one after; delete one
            // row past the cursor.
            await repository.put({ name: "aaa", type: "t", option: "v", success: true });
            await repository.put({ name: "m4_5", type: "t", option: "v", success: true });
            await repository.delete({ name: "m3", type: "t" });
          }
        } while (cursor);

        // We should never re-emit a row we've already seen, and we should
        // include every row that lived strictly after the cursor at the
        // moment we passed it.
        expect(new Set(seen).size).toBe(seen.length); // no duplicates
        expect(seen).toContain("m0");
        expect(seen).toContain("m1");
        expect(seen).not.toContain("aaa"); // sorts before cursor
        expect(seen).not.toContain("m3"); // deleted before next page
        expect(seen).toContain("m4_5"); // inserted after cursor, in unread tail
      });

      it("should reject malformed cursors", async () => {
        await expect(
          repository.getPage({ limit: 2, cursor: "not-a-real-cursor" as any })
        ).rejects.toThrow();
      });
    });

    describe("queryPage (cursor-based)", () => {
      it("should paginate filtered results", async () => {
        const entities = Array.from({ length: 8 }, (_, i) => ({
          name: `n${i}`,
          type: i % 2 === 0 ? "even" : "odd",
          option: `v${i}`,
          success: true,
        }));
        await repository.putBulk(entities);

        const seen: string[] = [];
        let cursor: PageCursor | undefined;
        try {
          do {
            const page = await repository.queryPage({ type: "even" }, { limit: 2, cursor });
            for (const row of page.items) seen.push(row.name);
            cursor = page.nextCursor;
          } while (cursor);
        } catch (err) {
          // Backends without `query()` support (e.g. FsFolder) can't
          // support `queryPage` either; skip this assertion for them.
          // `instanceof` is reliable across this monorepo because
          // `@workglow/storage` is the single source of the class.
          if (err instanceof StorageUnsupportedError) return;
          throw err;
        }

        expect(seen.sort()).toEqual(["n0", "n2", "n4", "n6"]);
      });
    });
  });
}

/**
 * Tests for auto-generated keys functionality
 */
export function runAutoGeneratedKeyTests(
  createAutoIncrementRepository: () => Promise<
    ITabularStorage<typeof AutoIncrementSchema, typeof AutoIncrementPrimaryKeyNames>
  >,
  createUuidRepository: () => Promise<
    ITabularStorage<typeof UuidSchema, typeof UuidPrimaryKeyNames>
  >
) {
  describe("Auto-Generated Keys", () => {
    describe("AutoIncrement Strategy", () => {
      let repository: ITabularStorage<
        typeof AutoIncrementSchema,
        typeof AutoIncrementPrimaryKeyNames
      >;

      beforeEach(async () => {
        repository = await createAutoIncrementRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should auto-generate integer ID when not provided", async () => {
        const entity = { name: "Test User", email: "test@example.com" };
        const result = await repository.put(entity as any);

        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe("number");
        expect(result.name).toBe("Test User");
        expect(result.email).toBe("test@example.com");
      });

      it("should auto-generate sequential IDs", async () => {
        const entity1 = { name: "User 1", email: "user1@example.com" };
        const entity2 = { name: "User 2", email: "user2@example.com" };
        const entity3 = { name: "User 3", email: "user3@example.com" };

        const result1 = await repository.put(entity1 as any);
        const result2 = await repository.put(entity2 as any);
        const result3 = await repository.put(entity3 as any);

        expect(result1.id).toBeDefined();
        expect(result2.id).toBeDefined();
        expect(result3.id).toBeDefined();

        // IDs should be sequential (though we don't enforce specific values)
        expect(result2.id).toBeGreaterThan(result1.id);
        expect(result3.id).toBeGreaterThan(result2.id);
      });

      it("should handle putBulk with auto-generated IDs", async () => {
        const entities = [
          { name: "Bulk 1", email: "bulk1@example.com" },
          { name: "Bulk 2", email: "bulk2@example.com" },
          { name: "Bulk 3", email: "bulk3@example.com" },
        ];

        const results = await repository.putBulk(entities as any);

        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result.id).toBeDefined();
          expect(typeof result.id).toBe("number");
        }
      });

      it("should retrieve entity by auto-generated ID", async () => {
        const entity = { name: "Retrievable", email: "retrieve@example.com" };
        const inserted = await repository.put(entity as any);

        const retrieved = await repository.get({ id: inserted.id });

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(inserted.id);
        expect(retrieved!.name).toBe("Retrievable");
        expect(retrieved!.email).toBe("retrieve@example.com");
      });
    });

    describe("UUID Strategy", () => {
      let repository: ITabularStorage<typeof UuidSchema, typeof UuidPrimaryKeyNames>;

      beforeEach(async () => {
        repository = await createUuidRepository();
        await repository.setupDatabase?.();
      });

      afterEach(async () => {
        await repository.deleteAll();
        repository.destroy();
      });

      it("should auto-generate UUID when not provided", async () => {
        const entity = { title: "Test Doc", content: "Test content" };
        const result = await repository.put(entity as any);

        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe("string");
        expect(result.id.length).toBeGreaterThan(0);
        // UUID v4 format check (loose)
        expect(result.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        expect(result.title).toBe("Test Doc");
        expect(result.content).toBe("Test content");
      });

      it("should generate unique UUIDs", async () => {
        const entity1 = { title: "Doc 1", content: "Content 1" };
        const entity2 = { title: "Doc 2", content: "Content 2" };

        const result1 = await repository.put(entity1 as any);
        const result2 = await repository.put(entity2 as any);

        expect(result1.id).toBeDefined();
        expect(result2.id).toBeDefined();
        expect(result1.id).not.toBe(result2.id);
      });

      it("should handle putBulk with auto-generated UUIDs", async () => {
        const entities = [
          { title: "Bulk Doc 1", content: "Bulk content 1" },
          { title: "Bulk Doc 2", content: "Bulk content 2" },
          { title: "Bulk Doc 3", content: "Bulk content 3" },
        ];

        const results = await repository.putBulk(entities as any);

        expect(results).toHaveLength(3);
        const ids = new Set();
        for (const result of results) {
          expect(result.id).toBeDefined();
          expect(typeof result.id).toBe("string");
          ids.add(result.id);
        }
        // All IDs should be unique
        expect(ids.size).toBe(3);
      });

      it("should retrieve entity by auto-generated UUID", async () => {
        const entity = { title: "Retrievable", content: "Can be found" };
        const inserted = await repository.put(entity as any);

        const retrieved = await repository.get({ id: inserted.id });

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(inserted.id);
        expect(retrieved!.title).toBe("Retrievable");
        expect(retrieved!.content).toBe("Can be found");
      });

      it("should return putBulk entities with auto-generated UUIDs in input order", async () => {
        // Distinct titles let us assert positional alignment without relying on PKs
        // (since the PKs are server- or client-generated and unknown to the caller).
        const entities = [
          { title: "first", content: "1" },
          { title: "second", content: "2" },
          { title: "third", content: "3" },
        ];

        const results = await repository.putBulk(entities as any);

        expect(results).toHaveLength(entities.length);
        for (let i = 0; i < entities.length; i++) {
          expect(results[i].title).toBe(entities[i].title);
          expect(results[i].content).toBe(entities[i].content);
          expect(typeof results[i].id).toBe("string");
        }
      });
    });
  });
}
