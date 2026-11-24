/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FsFolderKvStorage,
  StorageCorruptionError,
  StorageUnsupportedError,
} from "@workglow/storage";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGenericKvRepositoryTests } from "./genericKvRepositoryTests";

const testDir = ".cache/test/kv-fs-folder";

describe("FsFolderKvStorage", () => {
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

  runGenericKvRepositoryTests(async (keyType, valueType) => {
    // Create a deterministic file extension from the schema type
    const schemaType =
      typeof valueType === "object" && valueType !== null && "type" in valueType
        ? String(valueType.type)
        : "data";
    return new FsFolderKvStorage(
      testDir,
      (key) => `${String(key)}.${schemaType}`,
      keyType,
      valueType
    );
  });

  describe("contract symmetry", () => {
    const makeStore = () => new FsFolderKvStorage(testDir, (key) => `${String(key)}.data`);

    it("delete of a never-written key is an idempotent no-op (swallows ENOENT)", async () => {
      const store = makeStore();
      // Must not reject the way unlink() would on a missing path.
      await expect(store.delete("never-written")).resolves.toBeUndefined();
    });

    it("delete still emits a delete event for a missing key", async () => {
      const store = makeStore();
      let emitted: unknown;
      store.on("delete", (key) => {
        emitted = key;
      });
      await store.delete("missing");
      expect(emitted).toBe("missing");
    });

    it("getAll throws the typed StorageUnsupportedError", async () => {
      const store = makeStore();
      await expect(store.getAll()).rejects.toBeInstanceOf(StorageUnsupportedError);
    });

    it("size throws the typed StorageUnsupportedError", async () => {
      const store = makeStore();
      await expect(store.size()).rejects.toBeInstanceOf(StorageUnsupportedError);
    });
  });

  // `get` used to map every read failure to undefined, so a permission error
  // or a damaged file read as "no such key" and invited an overwrite.
  describe("read failures", () => {
    it("returns undefined only for a key that was never written", async () => {
      const store = new FsFolderKvStorage(testDir, (key) => `${String(key)}.data`);
      expect(await store.get("missing")).toBeUndefined();
    });

    it("rethrows a read error other than ENOENT", async () => {
      const store = new FsFolderKvStorage(testDir, (key) => `${String(key)}.data`);
      mkdirSync(`${testDir}/is-a-dir.data`, { recursive: true });
      await expect(store.get("is-a-dir")).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("raises StorageCorruptionError for a torn object value", async () => {
      const store = new FsFolderKvStorage(
        testDir,
        (key) => `${String(key)}.json`,
        { type: "string" },
        { type: "object" }
      );
      writeFileSync(`${testDir}/torn.json`, '{"a": 1, "b"');
      await expect(store.get("torn")).rejects.toBeInstanceOf(StorageCorruptionError);
    });

    it("put leaves no temp file behind", async () => {
      const store = new FsFolderKvStorage(
        testDir,
        (key) => `${String(key)}.json`,
        { type: "string" },
        { type: "object" }
      );
      await store.put("k", { a: 1 });
      await store.put("k", { a: 2 });
      expect(readdirSync(testDir)).toEqual(["k.json"]);
      expect(await store.get("k")).toEqual({ a: 2 });
    });
  });
});
