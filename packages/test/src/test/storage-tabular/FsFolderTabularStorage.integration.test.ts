/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { FsFolderTabularStorage, StorageUnsupportedError } from "@workglow/storage";
import { setLogger, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
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

    test("a corrupt row file is skipped and the readable rows still come back", async () => {
      const storage = await seed();
      writeFileSync(`${testDir}/corrupt.json`, "{ not json");
      expect((await storage.getAll())?.length).toBe(3);
      expect((await storage.getOffsetPage(0, 10))?.length).toBe(3);
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
