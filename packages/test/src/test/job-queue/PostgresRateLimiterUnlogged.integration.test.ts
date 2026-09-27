/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { PostgresRateLimiterStorage } from "@workglow/postgres/job-queue";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const db = new PGlite() as unknown as Pool;

async function persistence(table: string): Promise<string | undefined> {
  const { rows } = await db.query<{ relpersistence: string }>(
    "SELECT relpersistence FROM pg_class WHERE relname = $1",
    [table]
  );
  return rows[0]?.relpersistence;
}

describe("PostgresRateLimiterStorage table persistence", () => {
  afterAll(async () => {
    await (db as unknown as PGlite).close();
  });

  it("keeps the tables logged unless asked", async () => {
    await new PostgresRateLimiterStorage(db).migrate();
    expect(await persistence("rate_limit_executions")).toBe("p");
    expect(await persistence("rate_limit_next_available")).toBe("p");
  });

  it("makes existing tables unlogged when asked, and still reserves", async () => {
    const storage = new PostgresRateLimiterStorage(db, { unlogged: true });
    await storage.migrate();
    expect(await persistence("rate_limit_executions")).toBe("u");
    expect(await persistence("rate_limit_next_available")).toBe("u");
    // Idempotent: the version is recorded, so a second run changes nothing.
    await storage.migrate();
    expect(await storage.tryReserveExecution("q", 5, 60_000)).not.toBeNull();
  });
});
