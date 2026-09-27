/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { PostgresTabularStorage } from "@workglow/postgres/storage";
import { Sqlite, SqliteTabularStorage } from "@workglow/sqlite/storage";
import type { ValueOptionType } from "@workglow/storage";
import type { JsonSchema } from "@workglow/util/schema";
import type { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Every spelling of nullability the decoders branch on, plus the value types
 * whose decoding differs per backend (numeric strings, 0/1 booleans, JSON
 * text, dates-as-strings).
 */
const DecodeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    count: { type: "integer" },
    ratio: { anyOf: [{ type: "number" }, { type: "null" }] },
    maybe_int: { type: ["integer", "null"] },
    label: { oneOf: [{ type: "string", maxLength: 40 }, { type: "null" }] },
    flag: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    meta: { anyOf: [{ type: "object" }, { type: "null" }] },
    seen_at: { type: "string", format: "date-time" },
  },
  required: ["id", "count", "flag", "tags", "seen_at"],
  additionalProperties: false,
} as const;

const COLUMN_COUNT = Object.keys(DecodeSchema.properties).length;
const ROWS = 25;

function rowFor(i: number) {
  return {
    id: `r${String(i).padStart(3, "0")}`,
    count: i,
    ratio: i % 2 === 0 ? i / 4 : null,
    maybe_int: i % 3 === 0 ? null : i * 10,
    label: i % 5 === 0 ? null : `label ${i}`,
    flag: i % 2 === 1,
    tags: [`t${i}`, "x"],
    meta: i % 4 === 0 ? null : { n: i },
    seen_at: `2026-04-02T07:00:${String(i % 60).padStart(2, "0")}.001Z`,
  };
}

/** Counts schema derivations so the per-column memo is observable. */
function countingPostgres() {
  return class CountingPostgres extends PostgresTabularStorage<
    typeof DecodeSchema,
    readonly ["id"]
  > {
    nonNullCalls = 0;
    nullableCalls = 0;
    protected override getNonNullType(typeDef: JsonSchema): JsonSchema {
      this.nonNullCalls++;
      return super.getNonNullType(typeDef);
    }
    protected override isNullable(typeDef: JsonSchema): boolean {
      this.nullableCalls++;
      return super.isNullable(typeDef);
    }
  };
}

function countingSqlite() {
  return class CountingSqlite extends SqliteTabularStorage<typeof DecodeSchema, readonly ["id"]> {
    nonNullCalls = 0;
    nullableCalls = 0;
    protected override getNonNullType(typeDef: JsonSchema): JsonSchema {
      this.nonNullCalls++;
      return super.getNonNullType(typeDef);
    }
    protected override isNullable(typeDef: JsonSchema): boolean {
      this.nullableCalls++;
      return super.isNullable(typeDef);
    }
  };
}

describe("SQL tabular value conversion memoizes per-column schema facts", () => {
  beforeAll(async () => {
    await Sqlite.init();
  });

  const backends = [
    {
      name: "postgres",
      make: async () => {
        const Ctor = countingPostgres();
        const s = new Ctor(new PGlite() as unknown as Pool, "decode_rows", DecodeSchema, [
          "id",
        ] as const);
        await s.setupDatabase();
        return s;
      },
    },
    {
      name: "sqlite",
      make: async () => {
        const Ctor = countingSqlite();
        const s = new Ctor(new Sqlite.Database(":memory:"), "decode_rows", DecodeSchema, [
          "id",
        ] as const);
        await s.setupDatabase();
        return s;
      },
    },
  ] as const;

  for (const backend of backends) {
    describe(backend.name, () => {
      it("round-trips every column type unchanged", async () => {
        const s = await backend.make();
        const expected = Array.from({ length: ROWS }, (_, i) => rowFor(i));
        await s.putBulk(expected);

        const rows = (await s.getAll({ orderBy: [{ column: "id", direction: "ASC" }] })) ?? [];
        expect(rows).toEqual(expected);
        for (const row of rows) {
          expect(typeof row.count).toBe("number");
          expect(typeof row.flag).toBe("boolean");
          expect(typeof row.seen_at).toBe("string");
          expect(Array.isArray(row.tags)).toBe(true);
        }

        const one = await s.get({ id: "r003" });
        expect(one).toEqual(rowFor(3));
        const queried = await s.query({ count: 4 });
        expect(queried).toEqual([rowFor(4)]);
      });

      it("derives each column's schema facts once, not once per cell", async () => {
        const s = await backend.make();
        await s.putBulk(Array.from({ length: ROWS }, (_, i) => rowFor(i)));
        await s.getAll();
        await s.getAll();
        await s.query({ count: 7 });

        // Writes and reads both go through the memo; the number of derivations
        // is bounded by the column count however many cells were converted.
        // (DDL generation derives schema facts too, so those calls are taken
        // as a baseline after setup rather than assumed to be zero.)
        const before = { nonNull: s.nonNullCalls, nullable: s.nullableCalls };
        await s.putBulk(Array.from({ length: ROWS }, (_, i) => rowFor(i + ROWS)));
        await s.getAll();
        expect(s.nonNullCalls - before.nonNull).toBe(0);
        expect(s.nullableCalls - before.nullable).toBe(0);
        expect(s.nonNullCalls).toBeLessThan(ROWS * COLUMN_COUNT);
      });
    });
  }
});

describe("PostgresTabularStorage row hydration", () => {
  it("still routes every cell through an overridden sqlToJsValue", async () => {
    const seen: string[] = [];
    class Overriding extends PostgresTabularStorage<typeof DecodeSchema, readonly ["id"]> {
      protected override sqlToJsValue(column: string, value: ValueOptionType) {
        seen.push(column);
        const decoded = super.sqlToJsValue(column, value);
        return (
          column === "label" && typeof decoded === "string" ? decoded.toUpperCase() : decoded
        ) as never;
      }
    }
    const s = new Overriding(new PGlite() as unknown as Pool, "decode_override", DecodeSchema, [
      "id",
    ] as const);
    await s.setupDatabase();
    await s.putBulk([rowFor(1), rowFor(2)]);

    seen.length = 0;
    const rows = (await s.getAll({ orderBy: [{ column: "id", direction: "ASC" }] })) ?? [];
    expect(seen).toHaveLength(2 * COLUMN_COUNT);
    expect(rows.map((r) => r.label)).toEqual(["LABEL 1", "LABEL 2"]);
    expect(rows[0]).toEqual({ ...rowFor(1), label: "LABEL 1" });
  });
});
