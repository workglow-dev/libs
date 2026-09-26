/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScopedTabularStorage } from "@workglow/knowledge-base";
import type { AnyTabularStorage, ITabularStorage } from "@workglow/storage";
import { InMemoryTabularStorage, StorageValidationError } from "@workglow/storage";
import {
  AuthorSchema,
  CompoundPrimaryKeyNames,
  CompoundSchema,
  PostSchema,
  runTabularJoinContract,
  runTabularStorageContract,
} from "@workglow/test-contract/tabular-storage";
import type { AuthorStorage, PostStorage } from "@workglow/test-contract/tabular-storage";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

/**
 * `kb_id` has to be in the inner primary key — the wrapper refuses an inner
 * store whose key omits it, because the injection would then not distinguish
 * two knowledge bases' rows.
 */
function scopedInner<T extends DataPortSchemaObject>(schema: T): DataPortSchemaObject {
  return {
    ...schema,
    properties: { ...schema.properties, kb_id: { type: "string" } },
    required: [...(schema.required as readonly string[]), "kb_id"],
  } as DataPortSchemaObject;
}

const ScopedCompoundInner = scopedInner(CompoundSchema);
const ScopedPostInner = scopedInner(PostSchema);
const ScopedAuthorInner = scopedInner(AuthorSchema);

function scoped(
  innerSchema: DataPortSchemaObject,
  primaryKey: readonly string[],
  kbId: string
): ScopedTabularStorage<any, any, any, any, any> {
  const inner = new InMemoryTabularStorage(
    innerSchema as never,
    primaryKey as never,
    []
  ) as unknown as AnyTabularStorage;
  return new ScopedTabularStorage(inner, kbId) as ScopedTabularStorage<any, any, any, any, any>;
}

/**
 * The wrapper the knowledge base's shared-table path runs through, against the
 * shared contracts.
 *
 * `ScopedVectorStorage` already rides the vector contract; its tabular sibling
 * rode neither the tabular one nor the join one, and it does NOT inherit
 * `BaseTabularStorage.join` — it has its own delegate that splices the scope
 * predicate into the join CONDITION rather than applying it afterwards.
 * Applying it after is exactly what `a right-side filter under a left join
 * does not drop unmatched left rows` forbids, and nothing anywhere asserted
 * the wrapper gets it right.
 */
runTabularStorageContract({
  name: "ScopedTabularStorage",
  createStorage: async () =>
    scoped(
      ScopedCompoundInner,
      ["kb_id", ...CompoundPrimaryKeyNames],
      "kb-under-test"
    ) as unknown as ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>,
  capabilities: {
    supportsSubscriptions: true,
    supportsVectorColumns: false,
    supportsTransactions: false,
    supportsQuery: true,
  },
  // The inner store notifies on write, so the strict commit-order block is
  // the one that applies; the wrapper forwards rather than polling.
  usesPolling: false,
});

// `expectSqlPushdown` is left unset: a wrapper hands its INNER storage to the
// join, so the right-side `query` call lands on the inner's, not the wrapper's.
runTabularJoinContract(
  async () => scoped(ScopedPostInner, ["kb_id", "id"], "kb-under-test") as unknown as PostStorage,
  async () =>
    scoped(ScopedAuthorInner, ["kb_id", "id"], "kb-under-test") as unknown as AuthorStorage
);

/**
 * And the two things the contracts cannot ask, because they are what this
 * class adds rather than what the interface promises.
 */
describe("ScopedTabularStorage join scoping", () => {
  const seedPair = async (
    postsKb: string,
    authorsKb: string
  ): Promise<{ posts: any; authors: any }> => {
    const inner = new InMemoryTabularStorage(
      ScopedPostInner as never,
      ["kb_id", "id"] as never,
      []
    ) as unknown as AnyTabularStorage;
    const authorInner = new InMemoryTabularStorage(
      ScopedAuthorInner as never,
      ["kb_id", "id"] as never,
      []
    ) as unknown as AnyTabularStorage;

    const posts = new ScopedTabularStorage(inner, postsKb) as any;
    const otherPosts = new ScopedTabularStorage(inner, "kb-other") as any;
    const authors = new ScopedTabularStorage(authorInner, authorsKb) as any;
    const otherAuthors = new ScopedTabularStorage(authorInner, "kb-other") as any;

    await authors.put({ id: "a1", tenant: "t1", name: "Ann", country: "US" });
    await otherAuthors.put({ id: "a1", tenant: "t1", name: "NOT ANN", country: "ZZ" });
    await posts.put({ id: "p1", tenant: "t1", author_id: "a1", title: "one", views: 1 });
    await otherPosts.put({ id: "p9", tenant: "t1", author_id: "a1", title: "other", views: 9 });

    return { posts, authors };
  };

  it("joins only this scope's rows, on both sides, and strips kb_id", async () => {
    const { posts, authors } = await seedPair("kb-a", "kb-a");

    const rows = await posts.join(
      { type: "inner", on: [{ left: "author_id", right: "id" }] },
      authors
    );

    expect(rows.map((r: any) => `${r.left.id}:${r.right?.name}`)).toEqual(["p1:Ann"]);
    expect(rows[0].left).not.toHaveProperty("kb_id");
    expect(rows[0].right).not.toHaveProperty("kb_id");
  });

  it("keeps unmatched left rows under a LEFT join rather than filtering them out", async () => {
    // The scope predicate is spliced into the join CONDITION for this reason:
    // applied afterwards as a right-side filter, an unmatched left row would
    // carry a null right and be dropped by it.
    const { posts, authors } = await seedPair("kb-a", "kb-a");
    await posts.put({ id: "p2", tenant: "t1", author_id: "nobody", title: "orphan", views: 0 });

    const rows = await posts.join(
      { type: "left", on: [{ left: "author_id", right: "id" }] },
      authors
    );

    expect(rows.map((r: any) => `${r.left.id}:${r.right?.id ?? "-"}`).sort()).toEqual([
      "p1:a1",
      "p2:-",
    ]);
  });

  it("emits a delete event for the bulk path, with no kb_id on the identity", async () => {
    // Every concrete backend emits `delete` from `deleteSearch`, and a scoped
    // caller deletes through exactly that path — but the wrapper has its own
    // emitter, so the inner's event never reaches a listener on the wrapper.
    const { posts } = await seedPair("kb-a", "kb-a");
    const seen: Partial<Record<string, unknown>>[] = [];
    posts.on("delete", (identity: Record<string, unknown>) => {
      seen.push(identity);
    });

    await posts.deleteSearch({ tenant: "t1" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tenant: "t1" });
    // `kb_id` is the wrapper's bookkeeping, not a column the caller named.
    expect(seen[0]).not.toHaveProperty("kb_id");
  });

  it("emits nothing on the paths the delete guard stops", async () => {
    const { posts } = await seedPair("kb-a", "kb-a");
    const seen: unknown[] = [];
    posts.on("delete", (identity: unknown) => {
      seen.push(identity);
    });

    // Empty criteria are a no-op rather than a table wipe, so there is no
    // deletion to announce.
    await posts.deleteSearch({});
    // An all-empty exclusion is refused outright, and a throw is not a delete.
    await expect(posts.deleteSearch({ tenant: { value: [], operator: "not-in" } })).rejects.toThrow(
      /delete the whole table/
    );

    expect(seen).toEqual([]);
    const left = (await posts.getAll()) ?? [];
    expect(left).toHaveLength(1);
  });

  it("refuses an unscoped right side rather than joining across every scope", async () => {
    const { posts } = await seedPair("kb-a", "kb-a");
    const raw = new InMemoryTabularStorage(
      ScopedAuthorInner as never,
      ["kb_id", "id"] as never,
      []
    ) as unknown as AnyTabularStorage;

    await expect(
      posts.join({ type: "inner", on: [{ left: "author_id", right: "id" }] }, raw)
    ).rejects.toBeInstanceOf(StorageValidationError);
  });
});

describe("ScopedTabularStorage.putByUniqueKey", () => {
  const ItemSchema = {
    type: "object",
    properties: {
      kb_id: { type: "string" },
      id: { type: "string" },
      slug: { type: "string" },
      title: { type: "string" },
    },
    required: ["kb_id", "id", "slug", "title"],
    additionalProperties: false,
  } as const satisfies DataPortSchemaObject;

  it("matches the key within its own scope only, and hides kb_id", async () => {
    const inner = new InMemoryTabularStorage(
      ItemSchema,
      ["kb_id", "id"] as const,
      [],
      "if-missing",
      undefined,
      "inmemory",
      [["kb_id", "slug"]]
    ) as unknown as AnyTabularStorage;
    const a = new ScopedTabularStorage(inner, "kb-a") as ScopedTabularStorage<
      any,
      any,
      any,
      any,
      any
    >;
    const b = new ScopedTabularStorage(inner, "kb-b") as ScopedTabularStorage<
      any,
      any,
      any,
      any,
      any
    >;

    await a.putByUniqueKey({ id: "1", slug: "intro", title: "A" }, ["slug"]);
    const rewritten = await a.putByUniqueKey({ id: "9", slug: "intro", title: "A2" }, ["slug"]);
    expect(rewritten).toEqual({ entity: { id: "1", slug: "intro", title: "A2" }, inserted: false });
    // The same slug in another scope is another row.
    await b.putByUniqueKey({ id: "1", slug: "intro", title: "B" }, ["slug"]);
    expect(await a.getAll()).toEqual([{ id: "1", slug: "intro", title: "A2" }]);
    expect(await b.getAll()).toEqual([{ id: "1", slug: "intro", title: "B" }]);
  });
});
