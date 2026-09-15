/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { AnyTabularStorage } from "@workglow/storage";
import {
  CoveringIndexMissingError,
  HttpTabularProxyStorage,
  InMemoryTabularStorage,
} from "@workglow/storage";
import { describe, expect, it } from "vitest";
import {
  AuthorPrimaryKeyNames,
  AuthorSchema,
  PostPrimaryKeyNames,
  PostSchema,
  runTabularJoinContract,
} from "@workglow/test-contract/tabular-storage";

const TestSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    value: { type: "number" },
  },
  required: ["id", "name", "value"],
  additionalProperties: false,
} as const;
const TestPrimaryKey = ["id"] as const;

function toPublicErrorMessage(error: unknown): string {
  if (error instanceof CoveringIndexMissingError) {
    return "CoveringIndexMissingError";
  }
  return "internal server error";
}

// Loosely typed so the helper isn't re-instantiated against each caller's
// concrete Schema/PK generics — that deep instantiation tripped TS2589.
// AnyTabularStorage is the permissive supertype every backend satisfies.
function makeFakeServer(
  storage: AnyTabularStorage
): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path: string, init?: RequestInit) => {
    const match = /^\/api\/storage\/[^/]+\/([^/]+)$/.exec(path);
    if (!match) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const op = match[1];
    const body = init?.body ? JSON.parse(asText(init.body)) : {};
    try {
      switch (op) {
        case "put": {
          const entity = await storage.put(body.value);
          return new Response(JSON.stringify({ entity }), { status: 200 });
        }
        case "get": {
          const entity = await storage.get(body.key);
          return new Response(JSON.stringify({ entity: entity ?? null }), { status: 200 });
        }
        case "delete": {
          await storage.delete(body.key);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        case "getBulk": {
          const entities = await storage.getBulk(body.keys);
          return new Response(JSON.stringify({ entities }), { status: 200 });
        }
        case "putBulk": {
          const entities = await storage.putBulk(body.values);
          return new Response(JSON.stringify({ entities }), { status: 200 });
        }
        case "query": {
          const entities = await storage.query(body.criteria, body.options);
          return new Response(JSON.stringify({ entities: entities ?? null }), { status: 200 });
        }
        case "getAll": {
          const entities = await storage.getAll(body.options);
          return new Response(JSON.stringify({ entities: entities ?? null }), { status: 200 });
        }
        case "count": {
          const count = await storage.count(body.criteria);
          return new Response(JSON.stringify({ count }), { status: 200 });
        }
        case "size": {
          const size = await storage.size();
          return new Response(JSON.stringify({ size }), { status: 200 });
        }
        case "deleteAll": {
          await storage.deleteAll();
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        case "deleteSearch": {
          await storage.deleteSearch(body.criteria);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        case "updateWhere": {
          const entity = await storage.updateWhere(body.match, body.patch);
          return new Response(JSON.stringify({ entity: entity ?? null }), { status: 200 });
        }
        case "getOffsetPage": {
          const entities = await storage.getOffsetPage(body.offset, body.limit);
          return new Response(JSON.stringify({ entities: entities ?? null }), { status: 200 });
        }
        case "getPage": {
          const page = await storage.getPage(body.request);
          return new Response(JSON.stringify({ page }), { status: 200 });
        }
        case "queryPage": {
          const page = await storage.queryPage(body.criteria, body.request);
          return new Response(JSON.stringify({ page }), { status: 200 });
        }
        case "queryIndex": {
          const entities = await storage.queryIndex(body.criteria, body.options);
          return new Response(JSON.stringify({ entities }), { status: 200 });
        }
        default:
          return new Response(JSON.stringify({ error: `unknown op ${op}` }), { status: 404 });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: toPublicErrorMessage(err) }), { status: 500 });
    }
  };
}

describe("HttpTabularProxyStorage — put/get/delete", () => {
  it("put forwards the value and returns the server entity", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });

    const result = await proxy.put({ id: "a", name: "alpha", value: 1 });
    expect(result).toEqual({ id: "a", name: "alpha", value: 1 });
    expect(await backing.get({ id: "a" })).toEqual({ id: "a", name: "alpha", value: 1 });
  });

  it("get returns undefined when the server returns null", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.get({ id: "missing" } as never);
    expect(result).toBeUndefined();
  });

  it("get returns the stored entity", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "x", name: "ex", value: 42 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    expect(await proxy.get({ id: "x" } as never)).toEqual({ id: "x", name: "ex", value: 42 });
  });

  it("delete removes the entity from the backing store", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "del", name: "d", value: 0 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    await proxy.delete({ id: "del" } as never);
    expect(await backing.get({ id: "del" })).toBeUndefined();
  });

  it("propagates server error body as a thrown Error", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: fetchImpl,
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    await expect(proxy.put({ id: "a", name: "x", value: 1 })).rejects.toThrow(/boom/);
  });

  it("fake server hides internal exception messages", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const fetchImpl = makeFakeServer(backing);

    const res = await fetchImpl("/api/storage/things/getPage", {
      method: "POST",
      body: JSON.stringify({ request: { limit: 0 } }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal server error" });
  });

  it("strips trailing slashes from the base path", async () => {
    let requestedPath = "";
    const fetchImpl = async (path: string) => {
      requestedPath = path;
      return new Response(JSON.stringify({ size: 0 }), { status: 200 });
    };
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: fetchImpl,
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
      basePath: "/api/storage///",
    });

    await proxy.size();

    expect(requestedPath).toBe("/api/storage/things/size");
  });
});

describe("HttpTabularProxyStorage — bulk", () => {
  it("putBulk preserves input order", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.putBulk([
      { id: "a", name: "A", value: 1 },
      { id: "b", name: "B", value: 2 },
    ]);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("getBulk returns only found entities", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "A", value: 1 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.getBulk([{ id: "a" }, { id: "missing" }] as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "a" });
  });

  it("getBulk with empty keys returns empty array without calling the server", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response(JSON.stringify({ entities: [] }), { status: 200 });
    };
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: fetchImpl,
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    expect(await proxy.getBulk([])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("HttpTabularProxyStorage — query/getAll", () => {
  it("query forwards criteria + options", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "alpha", value: 1 });
    await backing.put({ id: "b", name: "alpha", value: 2 });
    await backing.put({ id: "c", name: "beta", value: 3 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.query({ name: "alpha" });
    expect(result).toHaveLength(2);
    expect(result?.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("getAll returns all rows", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "A", value: 1 });
    await backing.put({ id: "b", name: "B", value: 2 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.getAll();
    expect(result).toHaveLength(2);
  });

  it("query/getAll return undefined when the server sends entities: null", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ entities: null }), { status: 200 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: fetchImpl,
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    expect(await proxy.query({ name: "x" })).toBeUndefined();
    expect(await proxy.getAll()).toBeUndefined();
  });
});

describe("HttpTabularProxyStorage — count/size/delete bulk", () => {
  it("size returns row count", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "A", value: 1 });
    await backing.put({ id: "b", name: "B", value: 2 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    expect(await proxy.size()).toBe(2);
  });

  it("count with criteria filters", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "x", value: 1 });
    await backing.put({ id: "b", name: "y", value: 2 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    expect(await proxy.count({ name: "x" })).toBe(1);
  });

  it("deleteAll empties the table", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "A", value: 1 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    await proxy.deleteAll();
    expect(await backing.size()).toBe(0);
  });

  it("deleteSearch removes matching rows", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    await backing.put({ id: "a", name: "x", value: 1 });
    await backing.put({ id: "b", name: "y", value: 2 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    await proxy.deleteSearch({ name: "x" });
    expect(await backing.size()).toBe(1);
    expect(await backing.get({ id: "b" })).toBeDefined();
  });
});

describe("HttpTabularProxyStorage — pagination", () => {
  it("getOffsetPage returns a slice", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    for (const id of ["a", "b", "c", "d"]) {
      await backing.put({ id, name: id, value: id.charCodeAt(0) });
    }
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const page = await proxy.getOffsetPage(1, 2);
    expect(page).toHaveLength(2);
  });

  it("getPage paginates with a cursor", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    for (const id of ["a", "b", "c"]) {
      await backing.put({ id, name: id, value: id.charCodeAt(0) });
    }
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const first = await proxy.getPage({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await proxy.getPage({ limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("HttpTabularProxyStorage — queryIndex/withTransaction/lifecycle", () => {
  it("queryIndex forwards select projection", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey,
      [["name"]]
    );
    await backing.put({ id: "a", name: "alpha", value: 1 });
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const result = await proxy.queryIndex({ name: "alpha" }, { select: ["id", "name"] });
    expect(result).toEqual([{ id: "a", name: "alpha" }]);
  });

  it("withTransaction runs the callback (no rollback)", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    let ran = false;
    const result = await proxy.withTransaction(async (tx) => {
      ran = true;
      expect(tx).toBe(proxy);
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });

  it("setupDatabase and destroy are no-ops", async () => {
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: async () => new Response("", { status: 500 }),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    await expect(proxy.setupDatabase()).resolves.toBeUndefined();
    expect(() => proxy.destroy()).not.toThrow();
  });
});

describe("HttpTabularProxyStorage — subscribeToChanges", () => {
  it("polls and emits INSERT for new rows", async () => {
    const backing = new InMemoryTabularStorage<typeof TestSchema, typeof TestPrimaryKey>(
      TestSchema,
      TestPrimaryKey
    );
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: makeFakeServer(backing),
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });

    const events: string[] = [];
    const unsubscribe = proxy.subscribeToChanges(
      (change) => {
        events.push(`${change.type}:${change.new?.id ?? change.old?.id}`);
      },
      { pollingIntervalMs: 30 }
    );

    await new Promise((r) => setTimeout(r, 60));
    await backing.put({ id: "new1", name: "n", value: 0 });
    await new Promise((r) => setTimeout(r, 80));

    unsubscribe();
    expect(events).toContain("INSERT:new1");
  });

  it("compound-key collision: two rows whose naive join(|) keys match are both reported as INSERT", async () => {
    // {name:"x|y", type:"z"} and {name:"x", type:"y|z"} both produce "x|y|z" under naive join("|").
    // With fingerprinting they must produce distinct map keys, so neither row shadows the other.
    const backing = new InMemoryTabularStorage<
      typeof CompoundSchema,
      typeof CompoundPrimaryKeyNames
    >(CompoundSchema, CompoundPrimaryKeyNames);

    const proxy = new HttpTabularProxyStorage<
      typeof CompoundSchema,
      typeof CompoundPrimaryKeyNames
    >({
      fetch: makeFakeServer(backing),
      table: "compound",
      schema: CompoundSchema,
      primaryKey: CompoundPrimaryKeyNames,
    });

    // Seed both colliding rows before subscribing so both surface as INSERT on the first diff.
    await backing.put({ name: "x|y", type: "z", option: "o1", success: true });
    await backing.put({ name: "x", type: "y|z", option: "o2", success: false });

    // Both rows' name|type joins are the identical string "x|y|z", so we distinguish them
    // by their unique `option` value. With fingerprinted keys both appear; with a naive
    // join("|") key one row would shadow the other and only one INSERT would fire.
    const insertedOptions: string[] = [];
    const unsubscribe = proxy.subscribeToChanges(
      (change) => {
        if (change.type === "INSERT") {
          insertedOptions.push((change.new as { option: string }).option);
        }
      },
      { pollingIntervalMs: 30 }
    );

    await new Promise((r) => setTimeout(r, 120));
    unsubscribe();
    proxy.destroy();

    expect(insertedOptions).toContain("o1");
    expect(insertedOptions).toContain("o2");
  });

  it("unsubscribe stops polling", async () => {
    const fetchCounts = { calls: 0 };
    const fetchImpl = async () => {
      fetchCounts.calls++;
      return new Response(JSON.stringify({ entities: [] }), { status: 200 });
    };
    const proxy = new HttpTabularProxyStorage<typeof TestSchema, typeof TestPrimaryKey>({
      fetch: fetchImpl,
      table: "things",
      schema: TestSchema,
      primaryKey: TestPrimaryKey,
    });
    const unsubscribe = proxy.subscribeToChanges(() => {}, { pollingIntervalMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    const after = fetchCounts.calls;
    unsubscribe();
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchCounts.calls).toBe(after);
  });
});

import {
  AllTypesPrimaryKeyNames,
  AllTypesSchema,
  CompoundPrimaryKeyNames,
  CompoundSchema,
  runGenericTabularStorageTests,
  SearchPrimaryKeyNames,
  SearchSchema,
} from "./genericTabularStorageTests";

describe("HttpTabularProxyStorage — generic contract (CompoundSchema/SearchSchema/AllTypesSchema)", () => {
  const makeCompound = async () => {
    const backing = new InMemoryTabularStorage<
      typeof CompoundSchema,
      typeof CompoundPrimaryKeyNames
    >(CompoundSchema, CompoundPrimaryKeyNames);
    return new HttpTabularProxyStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>({
      fetch: makeFakeServer(backing as never),
      table: "compound",
      schema: CompoundSchema,
      primaryKey: CompoundPrimaryKeyNames,
    });
  };
  const makeSearch = async () => {
    const backing = new InMemoryTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>(
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
    return new HttpTabularProxyStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>({
      fetch: makeFakeServer(backing as never),
      table: "search",
      schema: SearchSchema,
      primaryKey: SearchPrimaryKeyNames,
      indexes: [
        "category",
        ["category", "subcategory"],
        ["subcategory", "category"],
        "value",
        "tag",
        ["category", "tag"],
      ],
    });
  };
  const makeAllTypes = async () => {
    const backing = new InMemoryTabularStorage<
      typeof AllTypesSchema,
      typeof AllTypesPrimaryKeyNames
    >(AllTypesSchema, AllTypesPrimaryKeyNames);
    return new HttpTabularProxyStorage<typeof AllTypesSchema, typeof AllTypesPrimaryKeyNames>({
      fetch: makeFakeServer(backing as never),
      table: "alltypes",
      schema: AllTypesSchema,
      primaryKey: AllTypesPrimaryKeyNames,
    });
  };
  runGenericTabularStorageTests(makeCompound, makeSearch, makeAllTypes);
});

describe("HttpTabularProxyStorage join", () => {
  // Both sides behind the proxy: the hash join runs over the wire with the
  // existing `getAll` / `query` ops, and needs no op of its own.
  runTabularJoinContract(
    async () => {
      const backing = new InMemoryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
        PostSchema,
        PostPrimaryKeyNames
      );
      return new HttpTabularProxyStorage<typeof PostSchema, typeof PostPrimaryKeyNames>({
        fetch: makeFakeServer(backing),
        table: "posts",
        schema: PostSchema,
        primaryKey: PostPrimaryKeyNames,
      });
    },
    async () => {
      const backing = new InMemoryTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
        AuthorSchema,
        AuthorPrimaryKeyNames
      );
      return new HttpTabularProxyStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>({
        fetch: makeFakeServer(backing),
        table: "authors",
        schema: AuthorSchema,
        primaryKey: AuthorPrimaryKeyNames,
      });
    },
    { expectSqlPushdown: false }
  );
});
