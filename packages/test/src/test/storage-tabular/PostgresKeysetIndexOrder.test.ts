/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { PostgresTabularStorage } from "@workglow/postgres/storage";
import { uuid4 } from "@workglow/util";
import type { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CompoundPrimaryKeyNames,
  CompoundSchema,
  NullableSearchPrimaryKeyNames,
  NullableSearchSchema,
} from "./genericTabularStorageTests";

const db = new PGlite() as unknown as Pool;

/** The SQL and params of every SELECT … ORDER BY the storage sends while `run` runs. */
async function capturePageSql(
  run: () => Promise<unknown>
): Promise<Array<{ sql: string; params: unknown[] }>> {
  const spy = vi.spyOn(db, "query");
  try {
    await run();
    return spy.mock.calls
      .map(([sql, params]) => ({ sql: String(sql), params: (params ?? []) as unknown[] }))
      .filter((c) => c.sql.includes("ORDER BY"));
  } finally {
    spy.mockRestore();
  }
}

describe("Postgres keyset paging over the primary key", () => {
  afterAll(async () => {
    await (db as unknown as PGlite).close();
  });

  it("orders primary key columns without NULLS placement, so the key index serves it", async () => {
    const table = `keyset_${uuid4().replace(/-/g, "_")}`;
    const repo = new PostgresTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      db,
      table,
      CompoundSchema,
      CompoundPrimaryKeyNames
    );
    await repo.setupDatabase();
    await repo.putBulk(
      Array.from({ length: 50 }, (_, i) => ({
        name: `n${String(i).padStart(2, "0")}`,
        type: i % 2 === 0 ? "a" : "b",
        option: "o",
        success: true,
      }))
    );

    const first = await repo.getPage({ limit: 10 });
    const [page] = await capturePageSql(() =>
      repo.getPage({ limit: 10, cursor: first.nextCursor })
    );
    expect(page.sql).toContain('ORDER BY "name" ASC, "type" ASC LIMIT');
    expect(page.sql).not.toContain("NULLS");

    await db.query("SET enable_seqscan = off");
    try {
      const plan = await db.query(`EXPLAIN ${page.sql}`, page.params);
      const text = (plan.rows as Array<Record<string, string>>)
        .map((r) => r["QUERY PLAN"])
        .join("\n");
      expect(text).toMatch(/Index (Only )?Scan/);
      expect(text).not.toMatch(/\bSort\b/);
    } finally {
      await db.query("RESET enable_seqscan");
    }

    const seen: string[] = [];
    let cursor = undefined as typeof first.nextCursor;
    do {
      const p = await repo.getPage({ limit: 7, cursor });
      seen.push(...p.items.map((r) => `${r.name}/${r.type}`));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(50);
    expect(seen).toEqual([...seen].sort());
  });

  it("drops the IS NULL arm of a descending key comparison", async () => {
    const table = `keyset_${uuid4().replace(/-/g, "_")}`;
    const repo = new PostgresTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      db,
      table,
      CompoundSchema,
      CompoundPrimaryKeyNames
    );
    await repo.setupDatabase();
    await repo.putBulk(
      ["a", "b", "c"].map((name) => ({ name, type: "t", option: "o", success: true }))
    );
    const orderBy = [{ column: "name", direction: "DESC" }] as const;
    const first = await repo.getPage({ limit: 1, orderBy: [...orderBy] });
    const [page] = await capturePageSql(() =>
      repo.getPage({ limit: 1, orderBy: [...orderBy], cursor: first.nextCursor })
    );
    expect(page.sql).not.toContain("IS NULL");
    expect(page.sql).toContain('ORDER BY "name" DESC, "type" ASC LIMIT');
    expect(first.items.map((r) => r.name)).toEqual(["c"]);
  });

  it("keeps NULLS placement on a column that can hold NULL", async () => {
    const table = `keyset_${uuid4().replace(/-/g, "_")}`;
    const repo = new PostgresTabularStorage<
      typeof NullableSearchSchema,
      typeof NullableSearchPrimaryKeyNames
    >(db, table, NullableSearchSchema, NullableSearchPrimaryKeyNames);
    await repo.setupDatabase();
    const [page] = await capturePageSql(() =>
      repo.getPage({ limit: 10, orderBy: [{ column: "value", direction: "ASC" }] })
    );
    expect(page.sql).toContain('ORDER BY "value" ASC NULLS FIRST, "id" ASC LIMIT');
  });
});
