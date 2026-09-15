/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryOptions } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorStorage, JoinFixturePost, PostStorage } from "../joinFixtures";

/**
 * How many left rows a call asked for, or `undefined` when it asked for all of
 * them. Read off the options the join handed the left read rather than off the
 * rows that came back, so a table that happens to be smaller than the bound
 * cannot pass for a bound that was never applied.
 */
function limitsOf(spy: { mock: { calls: unknown[][] } }): Array<number | undefined> {
  return spy.mock.calls.map(
    (call) => (call[call.length - 1] as QueryOptions<JoinFixturePost> | undefined)?.limit
  );
}

/**
 * What the hash join reads off the left side, and when it is allowed to stop.
 *
 * `join`'s own docstring makes a promise with a condition attached: `limit` and
 * `offset` apply to the joined rows, and the fallback "bounds the left read —
 * and stops early — only when the joined order does not need a sort", meaning
 * `orderBy` is absent or names left columns the left query can serve. An
 * `orderBy` touching the right side is sorted in memory, and that sort needs
 * every joined row, so such a join reads the whole left table however small its
 * `limit`.
 *
 * Both halves matter and they fail in opposite directions. Losing the bound is
 * a performance cliff a caller cannot see: over a remote backend a `limit: 2`
 * join quietly puts the whole table on the wire. Applying it when the order is
 * NOT already final is a wrong answer: the first N left rows in arbitrary order
 * are sorted afterwards and returned as though they were the top N. Nothing
 * else in this contract asserts either one — the pushdown is bounded by the
 * database, so only the fallback can be caught getting this wrong.
 */
export function joinBoundedLeftReadBlock(
  createPosts: () => Promise<PostStorage>,
  createAuthors: () => Promise<AuthorStorage>,
  seed: (posts: PostStorage, authors: AuthorStorage) => Promise<void>,
  opts: { readonly expectSqlPushdown?: boolean; readonly timeout?: number }
): void {
  const on = [{ left: "author_id", right: "id" }] as const;

  describe.skipIf(opts.expectSqlPushdown !== false)("join bounded left read", () => {
    let posts: PostStorage;
    let authors: AuthorStorage;

    beforeEach(async () => {
      posts = await createPosts();
      authors = await createAuthors();
      await posts.setupDatabase?.();
      await authors.setupDatabase?.();
      await seed(posts, authors);
    });

    afterEach(async () => {
      await posts.deleteAll();
      await authors.deleteAll();
      posts.destroy?.();
      authors.destroy?.();
      vi.restoreAllMocks();
    });

    it(
      "bounds the left read when no order is asked for",
      async () => {
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join({ type: "left", on, limit: 2 }, authors);

        expect(rows).toHaveLength(2);
        // A left join emits at least one row per left row, so the first bounded
        // pass already has what it needs and no widening pass follows.
        expect(limitsOf(leftRead)).toEqual([2]);
      },
      opts.timeout
    );

    it(
      "bounds the left read when the left query can serve the order",
      async () => {
        // `views` is non-nullable, which is what lets the order be pushed into
        // the left query — the two layers only agree about where nulls sort
        // when there are none.
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [{ side: "left", column: "views", direction: "DESC" }],
            limit: 2,
          },
          authors
        );

        expect(rows.map((r) => r.left.views)).toEqual([10, 9]);
        expect(limitsOf(leftRead)).toEqual([2]);
      },
      opts.timeout
    );

    it(
      "counts offset toward the bound rather than ignoring it",
      async () => {
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [{ side: "left", column: "views", direction: "DESC" }],
            offset: 2,
            limit: 2,
          },
          authors
        );

        expect(rows.map((r) => r.left.views)).toEqual([7, 5]);
        // Reading only `limit` rows would have returned the rows the offset was
        // meant to skip.
        expect(limitsOf(leftRead)).toEqual([4]);
      },
      opts.timeout
    );

    it(
      "widens the left read when an inner join drops too many rows",
      async () => {
        // Two of six posts have no author, so a bounded inner join produces
        // fewer joined rows than it read and has to come back for more.
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join({ type: "inner", on, limit: 4 }, authors);

        expect(rows).toHaveLength(4);
        const limits = limitsOf(leftRead);
        expect(limits.length).toBeGreaterThan(1);
        expect(limits[0]).toBe(4);
        // Geometric, not one row at a time: a linear widening makes the number
        // of round trips proportional to how selective the join turned out.
        expect(limits[1]).toBeGreaterThan(4);
      },
      opts.timeout
    );

    it(
      "reads the whole left side when the joined order needs a sort",
      async () => {
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [
              { side: "right", column: "name", direction: "ASC" },
              { side: "left", column: "id", direction: "ASC" },
            ],
            limit: 2,
          },
          authors
        );

        // The two unmatched posts sort first under ASC, which is only true if
        // every joined row was in hand before the sort ran.
        expect(rows.map((r) => r.left.id)).toEqual(["p4", "p5"]);
        expect(limitsOf(leftRead)).toEqual([undefined]);
      },
      opts.timeout
    );

    it(
      "reads the whole left side when the order names a nullable left column",
      async () => {
        // `author_id` is nullable, so the order cannot be pushed into the left
        // query; it is sorted here instead, and that sort needs every row.
        const leftRead = vi.spyOn(posts, "getAll");
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [
              { side: "left", column: "author_id", direction: "ASC" },
              { side: "left", column: "id", direction: "ASC" },
            ],
            limit: 2,
          },
          authors
        );

        expect(rows.map((r) => r.left.id)).toEqual(["p5", "p1"]);
        expect(limitsOf(leftRead)).toEqual([undefined]);
      },
      opts.timeout
    );

    it(
      "bounds the filtered left read the same way",
      async () => {
        // A `where.left` moves the read from `getAll` to `query`, and the bound
        // has to travel with it — this is the path a caller reaches for
        // precisely when the table is too big to read whole.
        const leftQuery = vi.spyOn(posts, "query");
        const rows = await posts.join(
          { type: "left", on, where: { left: { tenant: "t1" } }, limit: 2 },
          authors
        );

        expect(rows).toHaveLength(2);
        expect(limitsOf(leftQuery)).toEqual([2]);
      },
      opts.timeout
    );
  });
}
