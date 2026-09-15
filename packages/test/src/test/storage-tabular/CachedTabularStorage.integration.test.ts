/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CachedTabularStorage, InMemoryTabularStorage } from "@workglow/storage";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runTabularStorageContract,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/tabular-storage";
import {
  AuthorPrimaryKeyNames,
  AuthorSchema,
  PostPrimaryKeyNames,
  PostSchema,
  runGenericTabularJoinTests,
} from "./genericTabularJoinTests";
import { runGenericTabularStorageSubscriptionTests } from "./genericTabularStorageSubscriptionTests";
import {
  CompoundPrimaryKeyNames,
  CompoundSchema,
  runGenericTabularStorageTests,
  SearchPrimaryKeyNames,
  SearchSchema,
} from "./genericTabularStorageTests";

const spyOn = vi.spyOn;

describe("CachedTabularStorage", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  describe("generic repository tests", () => {
    runGenericTabularStorageTests(
      async () => {
        const durable = new InMemoryTabularStorage<
          typeof CompoundSchema,
          typeof CompoundPrimaryKeyNames
        >(CompoundSchema, CompoundPrimaryKeyNames);
        return new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
          durable,
          undefined,
          CompoundSchema,
          CompoundPrimaryKeyNames
        );
      },
      async () => {
        const durable = new InMemoryTabularStorage<
          typeof SearchSchema,
          typeof SearchPrimaryKeyNames
        >(SearchSchema, SearchPrimaryKeyNames, [
          "category",
          ["category", "subcategory"],
          ["subcategory", "category"],
          "value",
          "tag",
          ["category", "tag"],
        ]);
        return new CachedTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>(
          durable,
          undefined,
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
      }
    );
  });

  runGenericTabularStorageSubscriptionTests(
    async () => {
      const durable = new InMemoryTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(CompoundSchema, CompoundPrimaryKeyNames);
      return new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        durable,
        undefined,
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
    },
    { usesPolling: false }
  );

  describe("caching behavior", () => {
    let durable: InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;
    let cached: CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(() => {
      durable = new InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
      cached = new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        durable,
        undefined,
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
    });

    afterEach(async () => {
      await cached.deleteAll();
      cached.destroy();
    });

    it("should initialize cache from durable repository on first access", async () => {
      // Add data to durable before accessing cached
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };
      await durable.put(entity);

      // First access should initialize cache and load from durable
      const result = await cached.get({ name: "key1", type: "string1" });
      expect(result).toBeDefined();
      expect(result?.option).toEqual("value1");

      // Verify it's now in cache by checking cache directly
      const cacheResult = await cached.cache.get({ name: "key1", type: "string1" });
      expect(cacheResult).toBeDefined();
      expect(cacheResult?.option).toEqual("value1");
    });

    it("should read from cache on subsequent accesses", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      // Put through cached repository (writes to both durable and cache)
      await cached.put(entity);

      // Spy on durable.get to verify cache hit
      const durableGetSpy = spyOn(durable, "get");

      // First get should use cache (no durable.get call)
      const result1 = await cached.get({ name: "key1", type: "string1" });
      expect(result1?.option).toEqual("value1");

      // Verify durable.get was not called (cache hit)
      expect(durableGetSpy).toHaveBeenCalledTimes(0);

      durableGetSpy.mockRestore();
    });

    it("should populate cache when reading from durable (cache miss)", async () => {
      // Add data directly to durable (bypass cache)
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };
      await durable.put(entity);

      // Clear cache to simulate cache miss
      await cached.cache.deleteAll();

      // Get should read from durable and populate cache
      const result = await cached.get({ name: "key1", type: "string1" });
      expect(result?.option).toEqual("value1");

      // Verify cache was populated
      const cacheResult = await cached.cache.get({ name: "key1", type: "string1" });
      expect(cacheResult).toBeDefined();
      expect(cacheResult?.option).toEqual("value1");
    });

    it("should write to durable first, then cache", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      // Spy on both repositories
      const durablePutSpy = spyOn(durable, "put").mockImplementation(async (e) => e);
      const cachePutSpy = spyOn(cached.cache, "put").mockImplementation(async (e) => e);

      await cached.put(entity);

      // Verify both were called (implementation ensures durable is called first)
      expect(durablePutSpy).toHaveBeenCalledTimes(1);
      expect(cachePutSpy).toHaveBeenCalledTimes(1);

      durablePutSpy.mockRestore();
      cachePutSpy.mockRestore();
    });

    it("should update both cache and durable on put", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);

      // Verify in both repositories
      const durableResult = await durable.get({ name: "key1", type: "string1" });
      const cacheResult = await cached.cache.get({ name: "key1", type: "string1" });

      expect(durableResult?.option).toEqual("value1");
      expect(cacheResult?.option).toEqual("value1");
    });

    it("should update both cache and durable on putBulk", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
      ];

      await cached.putBulk(entities);

      // Verify all in both repositories
      for (const entity of entities) {
        const durableResult = await durable.get({
          name: entity.name,
          type: entity.type,
        });
        const cacheResult = await cached.cache.get({
          name: entity.name,
          type: entity.type,
        });

        expect(durableResult?.option).toEqual(entity.option);
        expect(cacheResult?.option).toEqual(entity.option);
      }
    });

    it("should delete from both cache and durable", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);

      // Verify exists in both
      expect(await durable.get({ name: "key1", type: "string1" })).toBeDefined();
      expect(await cached.cache.get({ name: "key1", type: "string1" })).toBeDefined();

      // Delete
      await cached.delete({ name: "key1", type: "string1" });

      // Verify removed from both
      expect(await durable.get({ name: "key1", type: "string1" })).toBeUndefined();
      expect(await cached.cache.get({ name: "key1", type: "string1" })).toBeUndefined();
    });

    it("should deleteAll from both cache and durable", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
      ];

      await cached.putBulk(entities);

      await cached.deleteAll();

      // Verify both are empty
      expect(await durable.getAll()).toBeUndefined();
      expect(await cached.cache.getAll()).toBeUndefined();
    });

    it("should search cache first, then durable if not found", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      // Put directly to durable
      await durable.put(entity);

      // Clear cache to force cache miss
      await cached.cache.deleteAll();

      // Query should find in durable and populate cache
      const results = await cached.query({ name: "key1" });
      expect(results?.length).toBe(1);
      expect(results?.[0].option).toEqual("value1");
    });

    it("should return size from durable (source of truth)", async () => {
      // Add to durable directly
      await durable.put({
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      });

      const size = await cached.size();
      expect(size).toBe(1);

      // Add more to durable
      await durable.put({
        name: "key2",
        type: "string2",
        option: "value2",
        success: false,
      });

      const newSize = await cached.size();
      expect(newSize).toBe(2);
    });

    it("should populate cache from durable getAll when cache is empty", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
      ];

      // Add to durable directly
      await durable.putBulk(entities);

      // Clear cache
      await cached.cache.deleteAll();

      // getAll should populate cache
      const results = await cached.getAll();
      expect(results?.length).toBe(2);

      // Verify cache was populated
      const cacheResults = await cached.cache.getAll();
      expect(cacheResults?.length).toBe(2);
    });

    it("should use cache getAll when cache is populated", async () => {
      const entities = [
        { name: "key1", type: "string1", option: "value1", success: true },
        { name: "key2", type: "string2", option: "value2", success: false },
      ];

      // Put through cached (populates both)
      await cached.putBulk(entities);

      // Spy on durable.getAll
      const durableGetAllSpy = spyOn(durable, "getAll");

      // getAll should use cache
      const results = await cached.getAll();
      expect(results?.length).toBe(2);

      // Verify durable.getAll was not called
      expect(durableGetAllSpy).toHaveBeenCalledTimes(0);

      durableGetAllSpy.mockRestore();
    });
  });

  describe("cache management", () => {
    let durable: InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;
    let cached: CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(() => {
      durable = new InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
      cached = new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        durable,
        undefined,
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
    });

    afterEach(async () => {
      await cached.deleteAll();
      cached.destroy();
    });

    it("should invalidate cache", async () => {
      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);

      // Verify in cache
      expect(await cached.cache.get({ name: "key1", type: "string1" })).toBeDefined();

      // Invalidate cache
      await cached.invalidateCache();

      // Cache should be empty
      expect(await cached.cache.getAll()).toBeUndefined();

      // Cache should be re-initialized on next access
      const result = await cached.get({ name: "key1", type: "string1" });
      expect(result?.option).toEqual("value1");
    });

    it("should refresh cache from durable", async () => {
      // Add initial data to durable
      await durable.put({
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      });

      // Access to initialize cache
      await cached.get({ name: "key1", type: "string1" });

      // Add more data to durable
      await durable.put({
        name: "key2",
        type: "string2",
        option: "value2",
        success: false,
      });

      // Refresh cache
      await cached.refreshCache();

      // Cache should have all data from durable
      const cacheResults = await cached.cache.getAll();
      expect(cacheResults?.length).toBe(2);
    });

    it("surfaces a cache warm-up failure instead of presenting an empty result", async () => {
      // A transient durable read failure during warm-up must NOT be swallowed:
      // query()/queryIndex() read only the cache, so a silently-failed warm-up
      // would return an empty result set as if the table were empty. The read
      // must fail loudly, and the warm-up must remain retryable.
      const errorDurable = new InMemoryTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(CompoundSchema, CompoundPrimaryKeyNames);

      const cachedWithError = new CachedTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(errorDurable, undefined, CompoundSchema, CompoundPrimaryKeyNames);

      // Seed a row so a successful warm-up would return it.
      await errorDurable.put({ name: "key1", type: "string1", option: "value1", success: true });

      // First warm-up read throws.
      const getAllSpy = spyOn(errorDurable, "getAll").mockRejectedValueOnce(
        new Error("Test error")
      );

      // The error is surfaced, not masked as "no rows".
      await expect(cachedWithError.get({ name: "key1", type: "string1" })).rejects.toThrow(
        "Test error"
      );

      // The failed warm-up is retryable: the spy only rejected once, so a
      // subsequent access re-runs init and returns the seeded row.
      getAllSpy.mockRestore();
      const result = await cachedWithError.get({ name: "key1", type: "string1" });
      expect(result?.option).toEqual("value1");

      cachedWithError.destroy();
    });
  });

  describe("event forwarding", () => {
    let durable: InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;
    let cached: CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(() => {
      durable = new InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
      cached = new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
        durable,
        undefined,
        CompoundSchema,
        CompoundPrimaryKeyNames
      );
    });

    afterEach(async () => {
      await cached.deleteAll();
      cached.destroy();
    });

    it("should forward put events from cache", async () => {
      const mockHandler = { handleEvent: (_entity: any) => {} };
      const putSpy = spyOn(mockHandler, "handleEvent");
      cached.on("put", putSpy);

      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);

      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(putSpy).toHaveBeenCalledWith(entity);
    });

    it("should forward get events from cache", async () => {
      const mockHandler = { handleEvent: (_key: any, _entity: any) => {} };
      const getSpy = spyOn(mockHandler, "handleEvent");
      cached.on("get", getSpy);

      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);
      await cached.get({ name: "key1", type: "string1" });

      expect(getSpy).toHaveBeenCalled();
      const callArgs = getSpy.mock.calls[0];
      expect(callArgs[0]).toEqual({ name: "key1", type: "string1" });
      expect(callArgs[1]?.option).toEqual("value1");
    });

    it("should forward query events from cache", async () => {
      const mockHandler = { handleEvent: (_key: any, _entities: any) => {} };
      const querySpy = spyOn(mockHandler, "handleEvent");
      cached.on("query", querySpy);

      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);
      await cached.query({ name: "key1" });

      expect(querySpy).toHaveBeenCalled();
      const callArgs = querySpy.mock.calls[0];
      expect(callArgs[0]).toEqual({ name: "key1" });
      expect(callArgs[1]?.length).toBe(1);
    });

    it("should forward delete events from cache", async () => {
      const mockHandler = { handleEvent: (_key: any) => {} };
      const deleteSpy = spyOn(mockHandler, "handleEvent");
      cached.on("delete", deleteSpy);

      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);
      await cached.delete({ name: "key1", type: "string1" });

      expect(deleteSpy).toHaveBeenCalled();
    });

    it("should forward clearall events from cache", async () => {
      const mockHandler = { handleEvent: () => {} };
      const clearallSpy = spyOn(mockHandler, "handleEvent");
      cached.on("clearall", clearallSpy);

      await cached.put({
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      });

      await cached.deleteAll();

      expect(clearallSpy).toHaveBeenCalled();
    });
  });

  describe("custom cache repository", () => {
    it("should use provided cache repository", async () => {
      const durable = new InMemoryTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(CompoundSchema, CompoundPrimaryKeyNames);

      const customCache = new InMemoryTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(CompoundSchema, CompoundPrimaryKeyNames);

      const cached = new CachedTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(durable, customCache, CompoundSchema, CompoundPrimaryKeyNames);

      expect(cached.cache).toBe(customCache);

      const entity = {
        name: "key1",
        type: "string1",
        option: "value1",
        success: true,
      };

      await cached.put(entity);

      // Verify entity is in custom cache
      const cacheResult = await customCache.get({ name: "key1", type: "string1" });
      expect(cacheResult?.option).toEqual("value1");

      cached.destroy();
    });
  });

  describe("constructor validation", () => {
    it("should throw error if schema and primaryKeyNames are not provided", () => {
      const durable = new InMemoryTabularStorage<
        typeof CompoundSchema,
        typeof CompoundPrimaryKeyNames
      >(CompoundSchema, CompoundPrimaryKeyNames);

      expect(() => {
        new CachedTabularStorage(durable);
      }).toThrow("Schema and primaryKeyNames must be provided");
    });
  });

  describe("deleteSearch", () => {
    let durable: InMemoryTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;
    let cached: CachedTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>;

    beforeEach(() => {
      durable = new InMemoryTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>(
        SearchSchema,
        SearchPrimaryKeyNames
      );
      cached = new CachedTabularStorage<typeof SearchSchema, typeof SearchPrimaryKeyNames>(
        durable,
        undefined,
        SearchSchema,
        SearchPrimaryKeyNames
      );
    });

    afterEach(async () => {
      await cached.deleteAll();
      cached.destroy();
    });

    it("should delete from both cache and durable using deleteSearch", async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const entities = [
        {
          id: "1",
          category: "electronics",
          subcategory: "phones",
          value: 100,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          id: "2",
          category: "electronics",
          subcategory: "phones",
          value: 200,
          createdAt: yesterday.toISOString(),
          updatedAt: yesterday.toISOString(),
        },
      ];

      await cached.putBulk(entities);

      // Delete entries older than now
      await cached.deleteSearch({ createdAt: { value: now.toISOString(), operator: "<" } });

      // Verify deleted from both
      const durableResults = await durable.getAll();
      const cacheResults = await cached.cache.getAll();

      // Only entry 1 should remain (createdAt >= now)
      expect(durableResults?.length).toBe(1);
      expect(cacheResults?.length).toBe(1);
      expect(durableResults?.[0].id).toBe("1");
      expect(cacheResults?.[0].id).toBe("1");
    });
  });
});

runTabularStorageContract({
  name: "CachedTabularStorage",
  createStorage: async () => {
    const durable = new InMemoryTabularStorage<
      typeof CompoundSchema,
      typeof CompoundPrimaryKeyNames
    >(CompoundSchema, CompoundPrimaryKeyNames);
    return new CachedTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      durable,
      undefined,
      CompoundSchema,
      CompoundPrimaryKeyNames
    );
  },
  capabilities: {
    supportsSubscriptions: true,
    supportsVectorColumns: true,
    supportsTransactions: false,
    supportsQuery: true,
  },
  // CachedTabularStorage forwards subscribeToChanges to the durable backing
  // store (here InMemoryTabularStorage), which is strictly event-driven.
  usesPolling: false,
  createVectorStorage: async () => {
    const durable = new InMemoryTabularStorage<
      typeof VectorItemSchema,
      typeof VectorItemPrimaryKeyNames
    >(VectorItemSchema, VectorItemPrimaryKeyNames);
    return new CachedTabularStorage<typeof VectorItemSchema, typeof VectorItemPrimaryKeyNames>(
      durable,
      undefined,
      VectorItemSchema,
      VectorItemPrimaryKeyNames
    );
  },
});

describe("CachedTabularStorage join", () => {
  runGenericTabularJoinTests(
    async () =>
      new CachedTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
        new InMemoryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
          PostSchema,
          PostPrimaryKeyNames
        ),
        undefined,
        PostSchema,
        PostPrimaryKeyNames
      ),
    async () =>
      new CachedTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
        new InMemoryTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
          AuthorSchema,
          AuthorPrimaryKeyNames
        ),
        undefined,
        AuthorSchema,
        AuthorPrimaryKeyNames
      )
  );

  it("reads the durable side, not the cache, and unwraps a cached right side", async () => {
    const durablePosts = new InMemoryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
      PostSchema,
      PostPrimaryKeyNames
    );
    const durableAuthors = new InMemoryTabularStorage<
      typeof AuthorSchema,
      typeof AuthorPrimaryKeyNames
    >(AuthorSchema, AuthorPrimaryKeyNames);
    const posts = new CachedTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
      durablePosts,
      undefined,
      PostSchema,
      PostPrimaryKeyNames
    );
    const authors = new CachedTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
      durableAuthors,
      undefined,
      AuthorSchema,
      AuthorPrimaryKeyNames
    );
    await authors.put({ id: "a1", tenant: "t", name: "Ann", country: null });
    await posts.put({ id: "p1", tenant: "t", author_id: "a1", title: "cached", views: 1 });
    // Written behind the cache's back: only a read of the durable side sees it.
    await durablePosts.put({ id: "p2", tenant: "t", author_id: "a1", title: "direct", views: 2 });
    const durableJoin = spyOn(durablePosts, "join");

    const rows = await posts.join(
      { type: "inner", on: [{ left: "author_id", right: "id" }] },
      authors
    );

    expect(rows.map((r) => r.left.id).sort()).toEqual(["p1", "p2"]);
    expect(durableJoin).toHaveBeenCalledWith(expect.anything(), durableAuthors);
  });
  it("unwraps a cached right side even when the left side is a plain storage", async () => {
    // The left side here delegates nothing, so nothing in the call chain is a
    // wrapper that could unwrap the right one on its own behalf.
    const posts = new InMemoryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
      PostSchema,
      PostPrimaryKeyNames
    );
    const durableAuthors = new InMemoryTabularStorage<
      typeof AuthorSchema,
      typeof AuthorPrimaryKeyNames
    >(AuthorSchema, AuthorPrimaryKeyNames);
    const authors = new CachedTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
      durableAuthors,
      undefined,
      AuthorSchema,
      AuthorPrimaryKeyNames
    );
    await authors.put({ id: "a1", tenant: "t", name: "Ann", country: null });
    // Warm the cache, then add an author behind its back: `authors.query` no
    // longer reports a9, but the durable side does.
    expect(await authors.getAll()).toHaveLength(1);
    await durableAuthors.put({ id: "a9", tenant: "t", name: "Nine", country: null });
    expect((await authors.query({ id: "a9" })) ?? []).toEqual([]);

    await posts.putBulk([
      { id: "p1", tenant: "t", author_id: "a1", title: "one", views: 1 },
      { id: "p9", tenant: "t", author_id: "a9", title: "nine", views: 2 },
    ]);

    // A join served by the cache would drop p9 — one half reading the cache
    // while the other reads durable is exactly the disagreement that costs
    // rows under an inner join.
    const rows = await posts.join(
      { type: "inner", on: [{ left: "author_id", right: "id" }] },
      authors
    );
    expect(rows.map((r) => `${r.left.id}:${r.right.id}`).sort()).toEqual(["p1:a1", "p9:a9"]);
  });
});
