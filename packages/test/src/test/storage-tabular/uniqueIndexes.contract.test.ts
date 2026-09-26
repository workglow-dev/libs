/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { IndexedDbTabularStorage } from "@workglow/indexeddb/storage";
import { PostgresTabularStorage } from "@workglow/postgres/storage";
import { Sqlite, SqliteTabularStorage } from "@workglow/sqlite/storage";
import { InMemoryTabularStorage, StorageError } from "@workglow/storage";
import { SupabaseTabularStorage } from "@workglow/supabase/storage";
import { uuid4 } from "@workglow/util";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import "fake-indexeddb/auto";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createSupabaseMockClient } from "../helpers/SupabaseMockClient";

/**
 * Contract for the `uniqueIndexes` constructor parameter wired through
 * BaseTabularStorage. Each backend must reject duplicate inserts whose values
 * collide on a declared unique tuple, even when the primary key differs.
 *
 * Notes on the per-backend implementation that this contract pins:
 *   - InMemoryTabularStorage scans the live row Map and throws StorageError
 *     before mutating state.
 *   - SqliteTabularStorage emits `CREATE UNIQUE INDEX IF NOT EXISTS`; the
 *     SQLite driver throws on collision.
 *   - PostgresTabularStorage emits the same DDL via PGlite.
 *   - SupabaseTabularStorage emits the same DDL via the `exec_sql` bootstrap
 *     (PGlite-backed mock here); PostgREST surfaces the collision.
 *   - IndexedDbTabularStorage creates native UNIQUE IDB indexes; a colliding
 *     `put` rejects with a `ConstraintError`.
 *
 * NULL semantics follow SQL's "NULL never collides with NULL" rule across
 * all backends — only complete tuples participate in the constraint.
 */

// Two non-PK columns we want to enforce a UNIQUE constraint on.
const PersonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    org_id: { type: "string" },
    name: { type: "string" },
  },
  required: ["id", "email", "org_id", "name"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

const PersonPK = ["id"] as const;

type PersonEntity = {
  id: string;
  email: string;
  org_id: string;
  name: string;
};

interface UniqueIndexBackend {
  readonly name: string;
  // The contract operates on shape (put/query/getAll), not the precise generic
  // type of any one backend, so the helper takes a permissive `any` storage
  // reference rather than over-constraining to one class.
  readonly create: (tableSuffix: string) => Promise<any>;
}

function runContract(backend: UniqueIndexBackend): void {
  describe(`${backend.name} — uniqueIndexes`, () => {
    it("rejects a duplicate single-column unique value across different PKs", async () => {
      const storage = (await backend.create("single")) as any;

      await storage.put({
        id: "p1",
        email: "alice@example.com",
        org_id: "orgA",
        name: "Alice",
      } as PersonEntity);

      // Different PK, same email → must throw.
      await expect(
        storage.put({
          id: "p2",
          email: "alice@example.com",
          org_id: "orgB",
          name: "Alice 2",
        } as PersonEntity)
      ).rejects.toThrow();

      // The first row is still there; the failed insert did not land.
      const rowsAfter = await storage.query({ email: "alice@example.com" });
      expect(rowsAfter).toBeDefined();
      expect(rowsAfter.length).toBe(1);
      expect(rowsAfter[0].id).toBe("p1");
    });

    it("allows re-inserting the same PK (UPSERT) without UNIQUE collision", async () => {
      const storage = (await backend.create("upsert")) as any;

      await storage.put({
        id: "p1",
        email: "alice@example.com",
        org_id: "orgA",
        name: "Alice",
      } as PersonEntity);

      // Same PK, same email → the existing row updates in place, no collision.
      await storage.put({
        id: "p1",
        email: "alice@example.com",
        org_id: "orgA",
        name: "Alice (renamed)",
      } as PersonEntity);

      const rows = await storage.query({ id: "p1" });
      expect(rows).toBeDefined();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice (renamed)");
    });

    it("rejects a duplicate compound unique tuple across different PKs", async () => {
      const storage = (await backend.create("compound")) as any;

      await storage.put({
        id: "p1",
        email: "alice@example.com",
        org_id: "orgA",
        name: "Alice",
      } as PersonEntity);

      // Same (org_id, name), different PK and email → must throw.
      await expect(
        storage.put({
          id: "p2",
          email: "alice2@example.com",
          org_id: "orgA",
          name: "Alice",
        } as PersonEntity)
      ).rejects.toThrow();

      // Differing on either compound column is fine.
      await storage.put({
        id: "p3",
        email: "alice3@example.com",
        org_id: "orgB",
        name: "Alice",
      } as PersonEntity);
      await storage.put({
        id: "p4",
        email: "alice4@example.com",
        org_id: "orgA",
        name: "Bob",
      } as PersonEntity);

      const all = (await storage.getAll())!;
      expect(all.length).toBe(3);
    });

    it("putByUniqueKey inserts a new key, then overwrites it in place keeping the PK", async () => {
      const storage = (await backend.create("pbuk_ins")) as any;
      const puts: PersonEntity[] = [];
      storage.on("put", (row: PersonEntity) => puts.push(row));

      const first = await storage.putByUniqueKey(
        { id: "p1", email: "alice@example.com", org_id: "orgA", name: "Alice" },
        ["email"]
      );
      expect(first.inserted).toBe(true);
      expect(first.entity).toMatchObject({ id: "p1", name: "Alice" });

      // Same email under another PK: written onto the existing row, whose PK stays.
      const second = await storage.putByUniqueKey(
        { id: "p2", email: "alice@example.com", org_id: "orgB", name: "Alice B" },
        ["email"]
      );
      expect(second.inserted).toBe(false);
      expect(second.entity).toEqual({
        id: "p1",
        email: "alice@example.com",
        org_id: "orgB",
        name: "Alice B",
      });
      const all = (await storage.getAll())!;
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(second.entity);
      expect(puts.length).toBeGreaterThanOrEqual(2);
      expect(puts[puts.length - 1]).toEqual(second.entity);
    });

    it("putByUniqueKey matches a compound key in any column order", async () => {
      const storage = (await backend.create("pbuk_cmp")) as any;
      await storage.putByUniqueKey(
        { id: "p1", email: "a@example.com", org_id: "orgA", name: "Alice" },
        ["org_id", "name"]
      );
      const again = await storage.putByUniqueKey(
        { id: "p9", email: "b@example.com", org_id: "orgA", name: "Alice" },
        ["name", "org_id"]
      );
      expect(again).toMatchObject({
        inserted: false,
        entity: { id: "p1", email: "b@example.com" },
      });
      // A different tuple is a different row.
      await storage.putByUniqueKey(
        { id: "p2", email: "c@example.com", org_id: "orgB", name: "Alice" },
        ["org_id", "name"]
      );
      expect((await storage.getAll())!).toHaveLength(2);
    });

    it("putByUniqueKey refuses an undeclared key or a null key value, writing nothing", async () => {
      const storage = (await backend.create("pbuk_ref")) as any;
      await expect(
        storage.putByUniqueKey(
          { id: "p1", email: "a@example.com", org_id: "orgA", name: "Alice" },
          ["name"]
        )
      ).rejects.toThrow(/not a unique index/);
      await expect(
        storage.putByUniqueKey(
          { id: "p1", email: "a@example.com", org_id: "orgA", name: "Alice" },
          ["org_id"]
        )
      ).rejects.toThrow(/not a unique index/);
      await expect(
        storage.putByUniqueKey({ id: "p1", email: null, org_id: "orgA", name: "Alice" }, ["email"])
      ).rejects.toThrow(/null/);
      expect((await storage.getAll()) ?? []).toHaveLength(0);
    });
  });
}

// In-memory backend — exercises the JS-side scan path.
runContract({
  name: "InMemoryTabularStorage",
  create: async () =>
    new InMemoryTabularStorage<typeof PersonSchema, typeof PersonPK>(
      PersonSchema,
      PersonPK,
      [],
      "if-missing",
      undefined,
      "inmemory",
      // single-column on email + compound on (org_id, name)
      [["email"], ["org_id", "name"]]
    ),
});

// In-memory backend — surface the exact error type for the upstream check.
describe("InMemoryTabularStorage — uniqueIndexes error type", () => {
  it("rejects duplicates with a StorageError instance", async () => {
    const storage = new InMemoryTabularStorage<typeof PersonSchema, typeof PersonPK>(
      PersonSchema,
      PersonPK,
      [],
      "if-missing",
      undefined,
      "inmemory",
      [["email"]]
    );

    await storage.put({
      id: "p1",
      email: "alice@example.com",
      org_id: "orgA",
      name: "Alice",
    } as PersonEntity);

    let caught: unknown;
    try {
      await storage.put({
        id: "p2",
        email: "alice@example.com",
        org_id: "orgB",
        name: "Alice 2",
      } as PersonEntity);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect(String((caught as Error).message)).toMatch(/UNIQUE/);
  });
});

// SQLite backend — exercises the `CREATE UNIQUE INDEX` DDL path.
describe("SqliteTabularStorage — uniqueIndexes", async () => {
  await Sqlite.init();
  runContract({
    name: "SqliteTabularStorage",
    create: async (suffix) => {
      const storage = new SqliteTabularStorage<typeof PersonSchema, typeof PersonPK>(
        ":memory:",
        `unique_${suffix}_${uuid4().replace(/-/g, "_")}`,
        PersonSchema,
        PersonPK,
        [],
        "if-missing",
        undefined,
        [["email"], ["org_id", "name"]]
      );
      await storage.setupDatabase();
      return storage;
    },
  });
});

// Postgres (PGlite) backend — exercises the parallel Postgres DDL path.
const pgliteDb = new PGlite() as unknown as Pool;
afterAll(async () => {
  await (pgliteDb as unknown as PGlite).close();
});

runContract({
  name: "PostgresTabularStorage",
  create: async (suffix) => {
    const storage = new PostgresTabularStorage<typeof PersonSchema, typeof PersonPK>(
      pgliteDb,
      `unique_${suffix}_${uuid4().replace(/-/g, "_")}`,
      PersonSchema,
      PersonPK,
      [],
      "if-missing",
      undefined,
      [["email"], ["org_id", "name"]]
    );
    await storage.setupDatabase();
    return storage as unknown as InstanceType<typeof InMemoryTabularStorage>;
  },
});

// Supabase backend — exercises the `CREATE UNIQUE INDEX` exec_sql bootstrap
// path against the same PGlite-backed mock the Supabase suite uses elsewhere.
const supabaseClient = createSupabaseMockClient();
afterAll(async () => {
  await supabaseClient.close();
});

runContract({
  name: "SupabaseTabularStorage",
  create: async (suffix) => {
    const storage = new SupabaseTabularStorage<typeof PersonSchema, typeof PersonPK>(
      supabaseClient,
      `unique_${suffix}_${uuid4().replace(/-/g, "_")}`,
      PersonSchema,
      PersonPK,
      [],
      "if-missing",
      [["email"], ["org_id", "name"]]
    );
    await storage.setupDatabase();
    return storage;
  },
});

// IndexedDB backend — exercises native UNIQUE IDB indexes via fake-indexeddb.
runContract({
  name: "IndexedDbTabularStorage",
  create: async (suffix) => {
    const storage = new IndexedDbTabularStorage<typeof PersonSchema, typeof PersonPK>(
      `unique_${suffix}_${uuid4().replace(/-/g, "_")}`,
      PersonSchema,
      PersonPK,
      [],
      {},
      "if-missing",
      undefined,
      [["email"], ["org_id", "name"]]
    );
    await storage.setupDatabase();
    return storage;
  },
});

// Tuple-overlap dedup happens in BaseTabularStorage so a single InMemory
// subclass that exposes `this.indexes` is enough to pin the behavior across
// every concrete backend.
describe("BaseTabularStorage — indexes / uniqueIndexes overlap dedup", () => {
  class IndexProbe extends InMemoryTabularStorage<typeof PersonSchema, typeof PersonPK> {
    getEffectiveIndexes(): ReadonlyArray<ReadonlyArray<string>> {
      return (this as unknown as { indexes: ReadonlyArray<ReadonlyArray<string>> }).indexes;
    }
  }

  it("drops a regular index whose tuple exactly matches a unique index", () => {
    const probe = new IndexProbe(
      PersonSchema,
      PersonPK,
      [["email"]],
      "if-missing",
      undefined,
      "inmemory",
      [["email"]]
    );
    expect(probe.getEffectiveIndexes()).toEqual([]);
  });

  it("drops a compound regular index that exactly matches a compound unique index", () => {
    const probe = new IndexProbe(
      PersonSchema,
      PersonPK,
      [["org_id", "name"]],
      "if-missing",
      undefined,
      "inmemory",
      [["org_id", "name"]]
    );
    expect(probe.getEffectiveIndexes()).toEqual([]);
  });

  it("keeps a regular index whose columns differ in order from the unique tuple", () => {
    // Index ordering matters for B-tree leftmost-prefix scans, so (name, org_id)
    // is genuinely different from (org_id, name) and should NOT be deduped.
    const probe = new IndexProbe(
      PersonSchema,
      PersonPK,
      [["name", "org_id"]],
      "if-missing",
      undefined,
      "inmemory",
      [["org_id", "name"]]
    );
    expect(probe.getEffectiveIndexes()).toEqual([["name", "org_id"]]);
  });

  it("keeps a single-column regular index that is a prefix (but not a match) of a unique tuple", () => {
    // The existing single-column carve-out in filterCompoundKeys preserves
    // dedicated narrow indexes; the unique (org_id, name) leftmost-prefix
    // scan walks wider rows than a dedicated (org_id) index.
    const probe = new IndexProbe(
      PersonSchema,
      PersonPK,
      [["org_id"]],
      "if-missing",
      undefined,
      "inmemory",
      [["org_id", "name"]]
    );
    expect(probe.getEffectiveIndexes()).toEqual([["org_id"]]);
  });

  it("preserves an unrelated regular index when a different unique tuple is declared", () => {
    const probe = new IndexProbe(
      PersonSchema,
      PersonPK,
      [["name"]],
      "if-missing",
      undefined,
      "inmemory",
      [["email"]]
    );
    expect(probe.getEffectiveIndexes()).toEqual([["name"]]);
  });
});

// A surrogate integer key the caller never knows, and identity held by a
// unique natural key — the shape `putByUniqueKey` exists for.
const ObservationSchema = {
  type: "object",
  properties: {
    id: { type: "integer", "x-auto-generated": true },
    doc: { type: "string" },
    idx: { type: "integer" },
    label: { type: "string" },
  },
  required: ["id", "doc", "idx", "label"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

const ObservationPK = ["id"] as const;

function runSurrogateKeyContract(name: string, create: () => Promise<any>): void {
  describe(`${name} — putByUniqueKey over a generated key`, () => {
    it("assigns the key once, and keeps it across rewrites", async () => {
      const storage = await create();
      const first = await storage.putByUniqueKey({ doc: "d1", idx: 0, label: "a" }, ["doc", "idx"]);
      expect(first.inserted).toBe(true);
      expect(typeof first.entity.id).toBe("number");
      const again = await storage.putByUniqueKey({ doc: "d1", idx: 0, label: "b" }, ["doc", "idx"]);
      expect(again).toEqual({
        entity: { id: first.entity.id, doc: "d1", idx: 0, label: "b" },
        inserted: false,
      });
      const other = await storage.putByUniqueKey({ doc: "d1", idx: 1, label: "c" }, ["doc", "idx"]);
      expect(other.inserted).toBe(true);
      expect(other.entity.id).not.toBe(first.entity.id);
      expect((await storage.getAll())!).toHaveLength(2);
    });

    it("converges two concurrent writers of one key on one row", async () => {
      const storage = await create();
      const [a, b] = await Promise.all([
        storage.putByUniqueKey({ doc: "d2", idx: 0, label: "x" }, ["doc", "idx"]),
        storage.putByUniqueKey({ doc: "d2", idx: 0, label: "y" }, ["doc", "idx"]),
      ]);
      expect(a.entity.id).toBe(b.entity.id);
      // Exactly one of the two inserted the row.
      expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
      const rows = (await storage.getAll())!;
      expect(rows).toHaveLength(1);
      expect(["x", "y"]).toContain(rows[0].label);
    });
  });
}

runSurrogateKeyContract(
  "InMemoryTabularStorage",
  async () =>
    new InMemoryTabularStorage<typeof ObservationSchema, typeof ObservationPK>(
      ObservationSchema,
      ObservationPK,
      [],
      "if-missing",
      undefined,
      "inmemory",
      [["doc", "idx"]]
    )
);

runSurrogateKeyContract("PostgresTabularStorage", async () => {
  const storage = new PostgresTabularStorage<typeof ObservationSchema, typeof ObservationPK>(
    pgliteDb,
    `obs_${uuid4().replace(/-/g, "_")}`,
    ObservationSchema,
    ObservationPK,
    [],
    "if-missing",
    undefined,
    [["doc", "idx"]]
  );
  await storage.setupDatabase();
  return storage;
});

describe("SqliteTabularStorage — putByUniqueKey over a generated key", async () => {
  await Sqlite.init();
  runSurrogateKeyContract("SqliteTabularStorage", async () => {
    const storage = new SqliteTabularStorage<typeof ObservationSchema, typeof ObservationPK>(
      ":memory:",
      `obs_${uuid4().replace(/-/g, "_")}`,
      ObservationSchema,
      ObservationPK,
      [],
      "if-missing",
      undefined,
      [["doc", "idx"]]
    );
    await storage.setupDatabase();
    return storage;
  });
});
