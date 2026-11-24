/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularMigration, PageCursor } from "@workglow/storage";
import {
  FsFolderTabularStorage,
  StorageCorruptionError,
  StorageUnsupportedError,
} from "@workglow/storage";
import { setLogger, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runTabularStorageContract } from "@workglow/test-contract/tabular-storage";
import { runGenericTabularStorageSubscriptionTests } from "./genericTabularStorageSubscriptionTests";
import {
  AllTypesPrimaryKeyNames,
  AllTypesSchema,
  CompoundPrimaryKeyNames,
  CompoundSchema,
  runGenericTabularStorageTests,
  SearchPrimaryKeyNames,
  SearchSchema,
} from "./genericTabularStorageTests";

const testDir = ".cache/test/testing";

describe("FsFolderTabularStorage", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {}
  });

  afterEach(async () => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {}
  });

  // Run basic storage tests that don't involve search
  describe("basic functionality", () => {
    runGenericTabularStorageTests(
      async () =>
        new FsFolderTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
          testDir,
          CompoundSchema,
          CompoundPrimaryKeyNames
        ),
      undefined,
      async () =>
        new FsFolderTabularStorage<typeof AllTypesSchema, typeof AllTypesPrimaryKeyNames>(
          testDir,
          AllTypesSchema,
          AllTypesPrimaryKeyNames
        )
    );
  });

  runGenericTabularStorageSubscriptionTests(
    async () =>
      new FsFolderTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        testDir,
        CompoundSchema,
        CompoundPrimaryKeyNames
      ),
    { usesPolling: true, pollingIntervalMs: 50, supportsDeleteSearch: false }
  );

  // Add specific tests for search functionality
  describe("search functionality", () => {
    test("should throw error when attempting to search", async () => {
      try {
        new FsFolderTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>(
          testDir,
          SearchSchema,
          SearchPrimaryKeyNames,
          [
            "category",
            ["category", "subcategory"],
            ["subcategory", "category"],
            "value",
            "tag",
            ["category", "tag"],
          ]
        );
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  // A row file that could not be read used to be dropped from the result set,
  // which handed callers a set that was short but looked complete: `size()`
  // still counted the file, and a migration backfill walking these pages left
  // that row un-migrated with nothing in the log. A directory named like a row
  // file is the portable stand-in for the transient read failure (`EMFILE` on a
  // loaded CI box) that produced it.
  describe("unreadable row files", () => {
    const seed = async () => {
      const storage = new FsFolderTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(testDir, CompoundSchema, CompoundPrimaryKeyNames);
      await storage.setupDatabase();
      for (let i = 0; i < 3; i++) {
        await storage.put({ name: `n${i}`, type: "t", option: "o", success: true });
      }
      return storage;
    };

    test("getAll throws rather than returning the readable rows alone", async () => {
      const storage = await seed();
      mkdirSync(`${testDir}/unreadable.json`);
      await expect(storage.getAll()).rejects.toThrow(/Failed to read file/);
    });

    test("getOffsetPage throws rather than returning the readable rows alone", async () => {
      const storage = await seed();
      mkdirSync(`${testDir}/unreadable.json`);
      await expect(storage.getOffsetPage(0, 10)).rejects.toThrow(/Failed to read file/);
    });

    // A row that does not parse used to be skipped with a warning, so it
    // vanished from every listing while size() still counted it.
    test("a corrupt row file raises a typed error naming the file", async () => {
      const storage = await seed();
      writeFileSync(`${testDir}/corrupt.json`, "{ not json");
      await expect(storage.getAll()).rejects.toBeInstanceOf(StorageCorruptionError);
      await expect(storage.getOffsetPage(0, 10)).rejects.toThrow(/corrupt\.json/);
    });

    test("a zero-byte row file (a torn write) raises rather than vanishing", async () => {
      const storage = await seed();
      const [victim] = readdirSync(testDir).filter((f) => f.endsWith(".json"));
      writeFileSync(`${testDir}/${victim}`, "");
      expect(await storage.size()).toBe(3);
      await expect(storage.getAll()).rejects.toBeInstanceOf(StorageCorruptionError);
    });
  });

  // Rows are written to a temp file and renamed into place. A crash between
  // the two leaves the temp file behind and the previous row untouched.
  describe("crash-safe writes", () => {
    const makeStorage = (dir: string) =>
      new FsFolderTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        dir,
        CompoundSchema,
        CompoundPrimaryKeyNames
      );

    test("a leftover temp file is ignored and the previous row survives", async () => {
      const dir = `${testDir}/crash_${uuid4()}`;
      const storage = makeStorage(dir);
      await storage.setupDatabase();
      await storage.put({ name: "a", type: "t", option: "v1", success: true });
      const [rowFile] = readdirSync(dir).filter((f) => f.endsWith(".json"));
      // What an interrupted put of "v2" leaves: a partial temp sibling.
      writeFileSync(`${dir}/${rowFile}.${uuid4()}.tmp`, '{"name":"a","type":"t","opt');

      expect(await storage.size()).toBe(1);
      const rows = await storage.getAll();
      expect(rows).toHaveLength(1);
      expect(rows?.[0].option).toBe("v1");
      expect((await storage.get({ name: "a", type: "t" }))?.option).toBe("v1");
    });

    test("put leaves no temp file behind and replaces the row whole", async () => {
      const dir = `${testDir}/crash_${uuid4()}`;
      const storage = makeStorage(dir);
      await storage.setupDatabase();
      await storage.put({ name: "a", type: "t", option: "v1", success: true });
      await storage.put({ name: "a", type: "t", option: "v2", success: false });
      const files = readdirSync(dir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(readFileSync(`${dir}/${files[0]}`, "utf8")).option).toBe("v2");
    });

    test("setupDatabase sweeps stale temp files but keeps fresh ones", async () => {
      const dir = `${testDir}/crash_${uuid4()}`;
      mkdirSync(dir, { recursive: true });
      const stale = `${dir}/row.json.${uuid4()}.tmp`;
      const fresh = `${dir}/row.json.${uuid4()}.tmp`;
      writeFileSync(stale, "{");
      writeFileSync(fresh, "{");
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(stale, hourAgo, hourAgo);
      await makeStorage(dir).setupDatabase();
      const left = readdirSync(dir);
      expect(left).toContain(fresh.slice(dir.length + 1));
      expect(left).not.toContain(stale.slice(dir.length + 1));
    });
  });

  // The migration bookkeeping file is read on every setupDatabase. Written in
  // place, a torn copy made the store unopenable with a bare SyntaxError.
  describe("migration bookkeeping", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" }, n: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    } as const;
    const migrations: ReadonlyArray<ITabularMigration> = [
      {
        component: "rows",
        version: 1,
        ops: [{ kind: "addIndex", name: "by_n", columns: ["n"] }],
      },
    ];

    test("is persisted without a temp file left behind", async () => {
      const dir = `${testDir}/mig_${uuid4()}`;
      const storage = new FsFolderTabularStorage(
        dir,
        schema,
        ["id"] as const,
        [],
        "if-missing",
        migrations
      );
      await storage.setupDatabase();
      const files = readdirSync(dir);
      expect(files).toContain("_storage_migrations.json");
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(readFileSync(`${dir}/_storage_migrations.json`, "utf8"))).toEqual({
        rows: [1],
      });
    });

    test("a corrupt bookkeeping file raises StorageCorruptionError", async () => {
      const dir = `${testDir}/mig_${uuid4()}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/_storage_migrations.json`, "");
      const storage = new FsFolderTabularStorage(
        dir,
        schema,
        ["id"] as const,
        [],
        "if-missing",
        migrations
      );
      await expect(storage.setupDatabase()).rejects.toBeInstanceOf(StorageCorruptionError);
    });
  });

  // The keyset page engine trusts `getAll({ orderBy, limit })` for the first page.
  // FsFolder once ignored both and returned rows in directory-listing order, which on
  // ext4 is a hash order: the first page was an arbitrary slice, its cursor an
  // arbitrary row, and the next page repeated rows sorting after it. A migration
  // backfill walking those pages doubled some rows twice. The listing is pinned to
  // reverse order here so the failure does not depend on the filesystem.
  describe("pages in key order whatever order the directory lists", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" }, n: { type: "integer" } },
      required: ["id", "n"],
      additionalProperties: false,
    } as const;

    const seed = async () => {
      const storage = new FsFolderTabularStorage(`${testDir}/order_${uuid4()}`, schema, [
        "id",
      ] as const);
      await storage.setupDatabase();
      for (let i = 0; i < 30; i++) await storage.put({ id: `r${i}`, n: i });
      const listRowFiles = (storage as any).listRowFiles.bind(storage);
      (storage as any).listRowFiles = async () => ((await listRowFiles()) as string[]).reverse();
      return storage;
    };

    test("getAll honours orderBy, offset and limit", async () => {
      const storage = await seed();
      const ids = (rows: Array<{ id: string }> | undefined) => rows?.map((r) => r.id);
      const sorted = Array.from({ length: 30 }, (_, i) => `r${i}`).sort();
      expect(ids(await storage.getAll({ orderBy: [{ column: "id", direction: "ASC" }] }))).toEqual(
        sorted
      );
      expect(
        ids(
          await storage.getAll({
            orderBy: [{ column: "id", direction: "DESC" }],
            offset: 2,
            limit: 3,
          })
        )
      ).toEqual(sorted.slice().reverse().slice(2, 5));
    });

    test("getPage visits every row exactly once", async () => {
      const storage = await seed();
      const seen: string[] = [];
      let cursor: PageCursor | undefined;
      do {
        const page = await storage.getPage({ limit: 7, cursor });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });
  });

  runTabularStorageContract({
    name: "FsFolderTabularStorage",
    createStorage: async () =>
      new FsFolderTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        `.cache/test/contract/fs_${uuid4().replace(/-/g, "_")}`,
        CompoundSchema,
        CompoundPrimaryKeyNames
      ),
    capabilities: {
      supportsSubscriptions: true,
      supportsVectorColumns: false,
      supportsTransactions: false,
      supportsQuery: false,
    },
    usesPolling: true,
    pollingIntervalMs: 50,
  });
});

describe("FsFolderTabularStorage join", () => {
  test("is unsupported, like query", async () => {
    const storage = new FsFolderTabularStorage<
      typeof CompoundSchema,
      typeof CompoundPrimaryKeyNames
    >(`${testDir}/join_${uuid4()}`, CompoundSchema, CompoundPrimaryKeyNames);
    await expect(
      storage.join({ type: "inner", on: [{ left: "name", right: "name" }] }, storage)
    ).rejects.toBeInstanceOf(StorageUnsupportedError);
  });
});
