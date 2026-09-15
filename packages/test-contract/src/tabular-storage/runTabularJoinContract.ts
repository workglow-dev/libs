/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JoinedRow } from "@workglow/storage";
import { StorageInvalidColumnError, StorageValidationError } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinBoundedLeftReadBlock } from "./assertions/joinBoundedLeftRead";
import { joinStrategyParityBlock } from "./assertions/strategyParity";
import type {
  AuthorStorage,
  JoinFixtureAuthor,
  JoinFixturePost,
  PostStorage,
} from "./joinFixtures";
import { JOIN_FIXTURE_AUTHORS, JOIN_FIXTURE_POSTS, seedJoinFixtures } from "./joinFixtures";

export {
  AuthorPrimaryKeyNames,
  AuthorSchema,
  JOIN_FIXTURE_AUTHORS,
  JOIN_FIXTURE_POSTS,
  PostPrimaryKeyNames,
  PostSchema,
  seedJoinFixtures,
} from "./joinFixtures";
export type {
  AuthorStorage,
  JoinFixtureAuthor,
  JoinFixturePost,
  PostStorage,
} from "./joinFixtures";

type Author = JoinFixtureAuthor;
type Post = JoinFixturePost;

export interface JoinTestOptions {
  /**
   * Which path the pair is expected to take. The proof is backend-agnostic:
   * the right storage's `query` is never called on the pushed-down path
   * (`true`) and always called on the hash-join path (`false`). Leave it unset
   * for a wrapper pair — a wrapper hands its inner storage to the join, so
   * the call lands on the inner's `query`, not the wrapper's.
   */
  readonly expectSqlPushdown?: boolean;
  readonly timeout?: number;
}

const pairs = (rows: ReadonlyArray<JoinedRow<Post, Author, any>>): string[] =>
  rows.map((r) => `${r.left.id}:${r.right?.id ?? "-"}`);

/**
 * Shared join behaviour, run per backend pair. `createPosts` is the left
 * side; `createAuthors` the right. Both are created fresh for every test.
 */
export function runTabularJoinContract(
  createPosts: () => Promise<PostStorage>,
  createAuthors: () => Promise<AuthorStorage>,
  opts: JoinTestOptions = {}
): void {
  const on = [{ left: "author_id", right: "id" }] as const;

  describe(`join (${opts.expectSqlPushdown ? "SQL pushdown" : "hash join"})`, () => {
    let posts: PostStorage;
    let authors: AuthorStorage;

    beforeEach(async () => {
      posts = await createPosts();
      authors = await createAuthors();
      await posts.setupDatabase?.();
      await authors.setupDatabase?.();
      await seedJoinFixtures(posts, authors);
    });

    afterEach(async () => {
      await posts.deleteAll();
      await authors.deleteAll();
      posts.destroy?.();
      authors.destroy?.();
      vi.restoreAllMocks();
    });

    it.skipIf(opts.expectSqlPushdown === undefined)(
      "takes the expected execution path",
      async () => {
        const rightQuery = vi.spyOn(authors, "query");
        await posts.join({ type: "inner", on }, authors);
        if (opts.expectSqlPushdown) {
          expect(rightQuery).not.toHaveBeenCalled();
        } else {
          expect(rightQuery).toHaveBeenCalled();
        }
      },
      opts.timeout
    );

    it(
      "inner join pairs every match and drops orphans and null keys",
      async () => {
        const rows = await posts.join({ type: "inner", on }, authors);
        expect(pairs(rows).sort()).toEqual(["p1:a1", "p2:a1", "p3:a2", "p6:a1"]);
        const row = rows.find((r) => r.left.id === "p1");
        expect(row?.left).toEqual(JOIN_FIXTURE_POSTS[0]);
        expect(row?.right).toEqual(JOIN_FIXTURE_AUTHORS[0]);
      },
      opts.timeout
    );

    it(
      "left join keeps orphans and null keys with right undefined",
      async () => {
        const rows = await posts.join({ type: "left", on }, authors);
        expect(pairs(rows).sort()).toEqual(["p1:a1", "p2:a1", "p3:a2", "p4:-", "p5:-", "p6:a1"]);
        expect(rows.find((r) => r.left.id === "p4")?.right).toBeUndefined();
        expect(rows.find((r) => r.left.id === "p5")?.right).toBeUndefined();
      },
      opts.timeout
    );

    it(
      "a right-side filter under a left join does not drop unmatched left rows",
      async () => {
        const rows = await posts.join(
          { type: "left", on, where: { right: { name: "Ann" } } },
          authors
        );
        expect(pairs(rows).sort()).toEqual(["p1:a1", "p2:a1", "p3:-", "p4:-", "p5:-", "p6:a1"]);
      },
      opts.timeout
    );

    it(
      "a right-side filter under an inner join narrows the result",
      async () => {
        const rows = await posts.join(
          { type: "inner", on, where: { right: { country: null } } },
          authors
        );
        expect(pairs(rows)).toEqual(["p3:a2"]);
      },
      opts.timeout
    );

    it(
      "a left-side filter narrows the left rows",
      async () => {
        const rows = await posts.join(
          { type: "left", on, where: { left: { views: { value: 5, operator: ">" } } } },
          authors
        );
        expect(pairs(rows).sort()).toEqual(["p1:a1", "p3:a2", "p6:a1"]);
      },
      opts.timeout
    );

    it(
      "joins on a compound key",
      async () => {
        const rows = await posts.join(
          {
            type: "inner",
            on: [
              { left: "tenant", right: "tenant" },
              { left: "author_id", right: "id" },
            ],
          },
          authors
        );
        expect(pairs(rows).sort()).toEqual(["p1:a1", "p2:a1", "p3:a2"]);
      },
      opts.timeout
    );

    it(
      "orders by a left column",
      async () => {
        const rows = await posts.join(
          { type: "left", on, orderBy: [{ side: "left", column: "views", direction: "DESC" }] },
          authors
        );
        expect(rows.map((r) => r.left.views)).toEqual([10, 9, 7, 5, 3, 1]);
      },
      opts.timeout
    );

    it(
      "orders by a right column with unmatched rows first under ASC",
      async () => {
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [
              { side: "right", column: "name", direction: "ASC" },
              { side: "left", column: "id", direction: "ASC" },
            ],
          },
          authors
        );
        expect(pairs(rows)).toEqual(["p4:-", "p5:-", "p1:a1", "p2:a1", "p6:a1", "p3:a2"]);
      },
      opts.timeout
    );

    it(
      "orders by a right column with unmatched rows last under DESC",
      async () => {
        const rows = await posts.join(
          {
            type: "left",
            on,
            orderBy: [
              { side: "right", column: "name", direction: "DESC" },
              { side: "left", column: "id", direction: "DESC" },
            ],
          },
          authors
        );
        expect(pairs(rows)).toEqual(["p3:a2", "p6:a1", "p2:a1", "p1:a1", "p5:-", "p4:-"]);
      },
      opts.timeout
    );

    it(
      "applies limit and offset to the joined rows",
      async () => {
        const rows = await posts.join(
          {
            type: "inner",
            on,
            orderBy: [{ side: "left", column: "id", direction: "ASC" }],
            offset: 1,
            limit: 2,
          },
          authors
        );
        expect(pairs(rows)).toEqual(["p2:a1", "p3:a2"]);
      },
      opts.timeout
    );

    it(
      "offset without limit skips rows",
      async () => {
        const rows = await posts.join(
          {
            type: "inner",
            on,
            orderBy: [{ side: "left", column: "id", direction: "ASC" }],
            offset: 3,
          },
          authors
        );
        expect(pairs(rows)).toEqual(["p6:a1"]);
      },
      opts.timeout
    );

    it(
      "honours a caller's own criterion on the join column",
      async () => {
        const rows = await posts.join(
          { type: "inner", on, where: { right: { id: "a2" } } },
          authors
        );
        expect(pairs(rows)).toEqual(["p3:a2"]);
      },
      opts.timeout
    );

    it(
      "returns [] rather than undefined when nothing matches",
      async () => {
        const rows = await posts.join(
          { type: "inner", on, where: { left: { title: "no such title" } } },
          authors
        );
        expect(rows).toEqual([]);
      },
      opts.timeout
    );

    it(
      "joins many distinct keys",
      async () => {
        const n = 1100;
        await authors.putBulk(
          Array.from({ length: n }, (_, i) => ({
            id: `b${i}`,
            tenant: "t9",
            name: `n${i}`,
            country: null,
          }))
        );
        await posts.putBulk(
          Array.from({ length: n }, (_, i) => ({
            id: `q${i}`,
            tenant: "t9",
            author_id: `b${i}`,
            title: `t${i}`,
            views: i,
          }))
        );
        const rows = await posts.join(
          { type: "inner", on, where: { left: { tenant: "t9" } } },
          authors
        );
        expect(rows).toHaveLength(n);
        expect(rows.every((r) => r.right.id === r.left.author_id)).toBe(true);
      },
      opts.timeout
    );

    it(
      "rejects an unknown column on either side before running",
      async () => {
        await expect(
          posts.join({ type: "inner", on: [{ left: "nope" as any, right: "id" }] }, authors)
        ).rejects.toBeInstanceOf(StorageInvalidColumnError);
        await expect(
          posts.join({ type: "inner", on: [{ left: "author_id", right: "nope" as any }] }, authors)
        ).rejects.toBeInstanceOf(StorageInvalidColumnError);
        await expect(
          posts.join(
            { type: "inner", on, orderBy: [{ side: "right", column: "views", direction: "ASC" }] },
            authors
          )
        ).rejects.toBeInstanceOf(StorageInvalidColumnError);
      },
      opts.timeout
    );

    it(
      "rejects a forged join type, side, direction, limit or offset",
      async () => {
        await expect(
          posts.join({ type: "cross; DROP TABLE x" as any, on }, authors)
        ).rejects.toBeInstanceOf(StorageValidationError);
        await expect(
          posts.join(
            { type: "inner", on, orderBy: [{ side: "x" as any, column: "id", direction: "ASC" }] },
            authors
          )
        ).rejects.toBeInstanceOf(StorageValidationError);
        await expect(
          posts.join(
            {
              type: "inner",
              on,
              orderBy: [{ side: "left", column: "id", direction: "ASC; --" as any }],
            },
            authors
          )
        ).rejects.toBeInstanceOf(StorageValidationError);
        await expect(posts.join({ type: "inner", on, limit: 0 }, authors)).rejects.toBeInstanceOf(
          StorageValidationError
        );
        await expect(posts.join({ type: "inner", on, offset: -1 }, authors)).rejects.toBeInstanceOf(
          StorageValidationError
        );
        await expect(posts.join({ type: "inner", on: [] }, authors)).rejects.toBeInstanceOf(
          StorageValidationError
        );
      },
      opts.timeout
    );
  });

  joinBoundedLeftReadBlock(createPosts, createAuthors, seedJoinFixtures, opts);
  joinStrategyParityBlock(createPosts, createAuthors, seedJoinFixtures, opts);
}
