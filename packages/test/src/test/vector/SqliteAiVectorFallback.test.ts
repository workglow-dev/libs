/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Sqlite, SqliteAiVectorStorage } from "@workglow/sqlite/storage";
import { setLogger } from "@workglow/util";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const VectorSchema = {
  type: "object",
  properties: {
    chunk_id: { type: "string" },
    vector: { type: "array", items: { type: "number" }, format: "TypedArray" },
    metadata: { type: "object", format: "metadata", additionalProperties: true },
  },
  required: ["chunk_id", "vector", "metadata"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

type VectorEntity = {
  chunk_id: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
};

/**
 * A handle opened without `allowExtension` is the shape the driver's own
 * no-`allowExtension` retry produces on a runtime whose SQLite is built
 * `SQLITE_OMIT_LOAD_EXTENSION`. `loadExtension` throws on it, and so does the
 * `vector_version()` probe.
 */
function extensionlessDatabase(): Sqlite.Database {
  return new Sqlite.Database(":memory:", { allowExtension: false });
}

/**
 * Asserting search RESULTS cannot catch this, by construction: the JS fallback
 * returns the same values the SQL path does. What has to be asserted is that
 * the storage says which one it is.
 */
describe("SqliteAiVectorStorage reports its fallback", () => {
  const logged: string[] = [];

  beforeEach(async () => {
    await Sqlite.init();
    logged.length = 0;
    setLogger({
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => logged.push(args.map(String).join(" ")),
      error: () => {},
    } as never);
  });

  afterEach(() => {
    setLogger(undefined as never);
  });

  it("warns rather than degrading in silence when the extension cannot load", async () => {
    const db = extensionlessDatabase();
    const storage = new SqliteAiVectorStorage<
      typeof VectorSchema,
      ["chunk_id"],
      never,
      VectorEntity
    >(db, "fallback_vectors", VectorSchema, ["chunk_id"], [], 3);
    try {
      await storage.setupDatabase();

      expect(storage.isVectorExtensionLoaded()).toBe(false);
      const reason = storage.getVectorFallbackReason();
      expect(reason).toBeDefined();
      // Both failures are kept: the probe is for a caller that loaded the
      // extension itself, so it must not stand in for why loading failed.
      expect(reason!.message).toContain("fallback_vectors");
      expect(reason!.loadError).toBeDefined();
      expect(reason!.probeError).toBeDefined();

      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join("\n")).toContain("sqlite-vector unavailable");
    } finally {
      db.close();
    }
  });

  it("refuses to come up under requireVectorExtension", async () => {
    const db = extensionlessDatabase();
    const storage = new SqliteAiVectorStorage<
      typeof VectorSchema,
      ["chunk_id"],
      never,
      VectorEntity
    >(db, "required_vectors", VectorSchema, ["chunk_id"], [], 3, Float32Array, {
      requireVectorExtension: true,
    });
    try {
      await expect(storage.setupDatabase()).rejects.toThrow(
        /sqlite-vector is unavailable for table "required_vectors"/
      );
      expect(storage.isVectorExtensionLoaded()).toBe(false);
    } finally {
      db.close();
    }
  });

  it("still serves reads and writes through the fallback", async () => {
    const db = extensionlessDatabase();
    const storage = new SqliteAiVectorStorage<
      typeof VectorSchema,
      ["chunk_id"],
      never,
      VectorEntity
    >(db, "working_fallback", VectorSchema, ["chunk_id"], [], 3);
    try {
      await storage.setupDatabase();
      await storage.put({
        chunk_id: "a",
        vector: new Float32Array([1, 0, 0]),
        metadata: {},
      } as never);

      const hits = await storage.similaritySearch(new Float32Array([1, 0, 0]), { topK: 1 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.chunk_id).toBe("a");
      // Degrading is not failing — that is exactly why it has to be reported.
      expect(storage.isVectorExtensionLoaded()).toBe(false);
    } finally {
      db.close();
    }
  });
});
