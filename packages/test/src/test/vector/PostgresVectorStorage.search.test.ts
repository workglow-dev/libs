/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PostgresVectorStorage } from "@workglow/postgres/storage";
import type { AnyVectorStorage } from "@workglow/storage";
import { uuid4 } from "@workglow/util";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import {
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/vector-storage";

// Its own instance rather than the validation suite's: that file closes its
// handle in an `afterAll`, which fires before a second top-level describe in
// the same file would run.
//
// PGlite ships pgvector as a loadable extension, and without it every case
// below passed through the in-memory fallback in `similaritySearch` — so the
// SQL this class actually issues in production (the distance operator, the
// score expression, the metadata predicate, ORDER BY/LIMIT) was never run by
// any test. The `PostgresVectorStorage DDL` block below is what keeps it that
// way.
const db = new PGlite({ extensions: { vector } }) as unknown as Pool;

afterAll(async () => {
  await (db as unknown as PGlite).close();
});

/**
 * The search half of this backend's contract. Its sibling
 * `PostgresVectorStorage.validation.test.ts` keeps what is specific to it — the
 * finite-number checks on a vector's individual components, which are about the
 * values rather than about what a search does with them.
 *
 * Nothing here was checked on this backend before. The seven cases that found
 * the equivalent break on SQLite were written against SQLite alone.
 */
runVectorStorageContract({
  name: "PostgresVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> =>
    new PostgresVectorStorage(
      db,
      `vec_contract_${uuid4().replace(/-/g, "_")}`,
      VectorItemSchema,
      VectorItemPrimaryKeyNames,
      [],
      VECTOR_DIMENSIONS
    ) as unknown as AnyVectorStorage,
});

describe("PostgresVectorStorage DDL", () => {
  it("declares a real vector column and indexes it", async () => {
    const table = `vec_ddl_${uuid4().replace(/-/g, "_")}`;
    const storage = new PostgresVectorStorage(
      db,
      table,
      VectorItemSchema,
      VectorItemPrimaryKeyNames,
      [],
      VECTOR_DIMENSIONS
    );
    await storage.setupDatabase();

    // A JSONB column here would not fail the contract above: the search would
    // simply throw inside `similaritySearch`, get swallowed by its fallback,
    // and be answered from memory with the right values and none of the SQL.
    const columns = await db.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'vector'`,
      [table]
    );
    expect(columns.rows[0]?.udt_name).toBe("vector");

    // And the index the column exists for: `vector_cosine_ops` rejects any
    // other column type, so this fails on the same regression from the far
    // side — creation is best-effort and only warns.
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
      [table]
    );
    expect(indexes.rows.map((r) => r.indexname)).toContain(`${table}_vector_hnsw_idx`);
  });
});
