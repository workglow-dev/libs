/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JoinedRow, JoinSpec, JoinType } from "@workglow/storage";
import { BaseTabularStorage } from "@workglow/storage";
import { describe, expect, it } from "vitest";
import type {
  AuthorStorage,
  JoinFixtureAuthor,
  JoinFixturePost,
  PostStorage,
} from "../joinFixtures";

type Spec = JoinSpec<JoinFixturePost, JoinFixtureAuthor, JoinType>;

/**
 * One value a `JoinSpec` field can take, with a name the test title reads.
 *
 * `undefined` is a value like any other here — "no `orderBy`" is the case that
 * decides whether the hash join may bound its left read, so leaving it out
 * would drop the axis's most load-bearing point.
 */
interface Variant<K extends keyof Spec> {
  readonly label: string;
  readonly value: Spec[K];
}

/**
 * Every field of `JoinSpec`, with the values this block varies it over.
 *
 * Mapped over `Required<Spec>` rather than written as a loose record: a field
 * added to `JoinSpec` makes this object fail to typecheck until it declares
 * what the two strategies should agree about for it. That is the whole point —
 * a new join option is covered because it cannot compile otherwise, not
 * because someone remembered this file.
 */
type SpecAxes = { readonly [K in keyof Required<Spec>]: ReadonlyArray<Variant<K>> };

const AXES: SpecAxes = {
  type: [
    { label: "inner", value: "inner" },
    { label: "left", value: "left" },
  ],
  on: [
    { label: "one key", value: [{ left: "author_id", right: "id" }] },
    {
      label: "a compound key",
      value: [
        { left: "tenant", right: "tenant" },
        { left: "author_id", right: "id" },
      ],
    },
  ],
  where: [
    { label: "no filter", value: undefined },
    { label: "a left filter", value: { left: { views: { value: 5, operator: ">" } } } },
    { label: "a right filter", value: { right: { name: "Ann" } } },
    { label: "a null right filter", value: { right: { country: null } } },
    {
      label: "both filters",
      value: { left: { tenant: "t1" }, right: { name: "Ann" } },
    },
  ],
  orderBy: [
    // No order at all: the one case where the hash join is free to bound its
    // left read, so its result has to match a pushdown that read everything.
    { label: "no order", value: undefined },
    {
      label: "a left order",
      value: [{ side: "left", column: "views", direction: "DESC" }],
    },
    {
      // A nullable left column. The hash join refuses to push this into the
      // left query because the backends disagree with it about where nulls
      // sort — so this is the pair most likely to come back differently.
      label: "a nullable left order",
      value: [
        { side: "left", column: "author_id", direction: "ASC" },
        { side: "left", column: "id", direction: "ASC" },
      ],
    },
    {
      label: "a right order",
      value: [
        { side: "right", column: "name", direction: "ASC" },
        { side: "left", column: "id", direction: "ASC" },
      ],
    },
    {
      label: "a descending right order",
      value: [
        { side: "right", column: "name", direction: "DESC" },
        { side: "left", column: "id", direction: "DESC" },
      ],
    },
  ],
  limit: [
    { label: "no limit", value: undefined },
    { label: "a limit of 2", value: 2 },
    // Larger than the joined row count, so the two paths agree on what
    // "bounded by more rows than exist" means.
    { label: "a limit of 50", value: 50 },
  ],
  offset: [
    { label: "no offset", value: undefined },
    { label: "an offset of 1", value: 1 },
    { label: "an offset past the end", value: 99 },
  ],
};

/** The first variant of each axis — what every other axis is varied against. */
const BASE: Spec = {
  type: AXES.type[0].value,
  on: AXES.on[0].value,
};

/**
 * One spec per axis value, holding every other axis at its first variant, plus
 * the combinations where two axes interact.
 *
 * A full cross product is 600 specs and most of them prove the same thing
 * twice. What is NOT dropped is the pairing of `orderBy` with `limit`/`offset`:
 * the joined order decides whether the hash join may stop reading early, and a
 * bound is what makes stopping early observable, so a one-axis-at-a-time sweep
 * would never run the two together and would miss exactly the divergence this
 * block exists for.
 */
function buildSpecs(): Array<{ readonly label: string; readonly spec: Spec }> {
  const specs: Array<{ label: string; spec: Spec }> = [];
  const seen = new Set<string>();
  const add = (label: string, spec: Spec): void => {
    const key = JSON.stringify(spec);
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ label, spec });
  };

  for (const key of Object.keys(AXES) as Array<keyof SpecAxes>) {
    for (const variant of AXES[key]) {
      add(variant.label, { ...BASE, [key]: variant.value } as Spec);
    }
  }

  for (const type of AXES.type) {
    for (const order of AXES.orderBy) {
      for (const limit of AXES.limit) {
        for (const offset of AXES.offset) {
          add(`${type.label} join, ${order.label}, ${limit.label}, ${offset.label}`, {
            ...BASE,
            type: type.value,
            orderBy: order.value,
            limit: limit.value,
            offset: offset.value,
          } as Spec);
        }
      }
    }
  }

  return specs;
}

const SPECS = buildSpecs();

/**
 * Rows of `part` that `whole` cannot account for, counting repeats.
 *
 * Membership alone is too weak: every element of `[p1, p1]` is a member of a
 * `whole` holding one `p1`, so a strategy that returned a row twice where the
 * join produces it once would pass a containment check while having invented a
 * row.
 */
function multisetRemainder(part: readonly string[], whole: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const row of whole) available.set(row, (available.get(row) ?? 0) + 1);
  const unaccounted: string[] = [];
  for (const row of part) {
    const left = available.get(row) ?? 0;
    if (left === 0) unaccounted.push(row);
    else available.set(row, left - 1);
  }
  return unaccounted;
}

/** How many rows `spec`'s window leaves of a join producing `total` of them. */
function windowLength(total: number, spec: Spec): number {
  const remaining = Math.max(0, total - (spec.offset ?? 0));
  return spec.limit === undefined ? remaining : Math.min(spec.limit, remaining);
}

/** Rows reduced to what both strategies must agree on. */
function shape(
  rows: ReadonlyArray<JoinedRow<JoinFixturePost, JoinFixtureAuthor, JoinType>>
): string[] {
  return rows.map((row) => `${row.left.id}:${row.right?.id ?? "-"}`);
}

/**
 * How much of a result the two strategies are actually held to, given the spec.
 *
 * A join with no `orderBy` has no defined row order — `join` promises that
 * `orderBy`, `limit` and `offset` apply to the joined rows, never what order
 * the joined rows arrive in when nothing asked. SQLite and Postgres happen to
 * return them in a stable order and DuckDB, being columnar and parallel, does
 * not; holding the strategies to a shared order there would assert the storage
 * engine's row layout rather than the contract, and would fail on a backend
 * that is behaving correctly.
 *
 * So an unordered join is compared as a SET, and an unordered join that is also
 * windowed is compared only by how many rows came back and whether each is a
 * row the unwindowed join would have returned. That is the whole of what is
 * determined: a window into an undefined order names no particular rows.
 */
function sortRows(rows: JoinRows): JoinRows {
  return [...rows].sort((a, b) =>
    `${a.left.id}:${a.right?.id ?? "-"}`.localeCompare(`${b.left.id}:${b.right?.id ?? "-"}`)
  );
}

function comparisonFor(spec: Spec): "ordered" | "set" | "window" {
  if ((spec.orderBy?.length ?? 0) > 0) return "ordered";
  return spec.limit === undefined && spec.offset === undefined ? "set" : "window";
}

type JoinRows = Array<JoinedRow<JoinFixturePost, JoinFixtureAuthor, JoinType>>;

/**
 * The inherited hash join, typed for these two fixtures.
 *
 * One cast, at the one place the erased generics of a prototype method have to
 * be restated, rather than a cast per call site.
 */
type HashJoinFn = (this: PostStorage, spec: Spec, right: AuthorStorage) => Promise<JoinRows>;

/**
 * Runs `spec` through the inherited hash join, on the same two instances the
 * pushdown just ran on.
 *
 * Reaching for the base implementation rather than standing a second storage up
 * on another connection is what keeps the comparison honest: same data, same
 * backend, same driver, one difference. A second connection would also change
 * which rows are visible, and a divergence would no longer say which half
 * caused it.
 */
const viaHashJoin = BaseTabularStorage.prototype.join as unknown as HashJoinFn;

/**
 * The two join strategies answer the same question the same way.
 *
 * `ITabularStorage.join` has one documented semantics and two implementations —
 * a single `JOIN` statement when both tables share a connection, and an
 * application-side hash join otherwise — and which one runs is decided by the
 * planner, not by the caller. So a caller cannot tell them apart, and any
 * disagreement between them is a wrong answer that no error reports and that
 * changes with where the right-hand storage happens to live.
 *
 * That has already happened once: a pushdown chosen against a right side
 * enlisted in a transaction it could not see returned zero rows from an inner
 * join where the same call through the fallback returned the row. The block
 * that covered `join` at the time stayed green throughout, because it asserted
 * which path ran and never compared what the two paths returned.
 *
 * This asserts the second thing. It runs only where both strategies are
 * reachable — a pair the planner pushes down — and compares them over specs
 * derived from the option space rather than a list, so an option added to
 * `JoinSpec` is covered by construction.
 */
export function joinStrategyParityBlock(
  createPosts: () => Promise<PostStorage>,
  createAuthors: () => Promise<AuthorStorage>,
  seed: (posts: PostStorage, authors: AuthorStorage) => Promise<void>,
  opts: { readonly expectSqlPushdown?: boolean; readonly timeout?: number }
): void {
  describe.skipIf(opts.expectSqlPushdown !== true)("join strategy parity", () => {
    it(
      "states, for every field of a join spec, what the two strategies agree about",
      () => {
        // The ratchet's runtime half. `SpecAxes` already makes a new `JoinSpec`
        // field a compile error; this catches the other way of emptying an
        // axis — declaring it with no variants — which would type fine and
        // silently stop varying the field.
        const empty = (Object.keys(AXES) as Array<keyof SpecAxes>).filter(
          (key) => AXES[key].length === 0
        );
        expect(empty).toEqual([]);
        expect(SPECS.length).toBeGreaterThan(AXES.orderBy.length * AXES.limit.length);
      },
      opts.timeout
    );

    for (const { label, spec } of SPECS) {
      it(
        `the pushdown and the hash join agree on ${label}`,
        async () => {
          const posts = await createPosts();
          const authors = await createAuthors();
          try {
            await posts.setupDatabase?.();
            await authors.setupDatabase?.();
            await seed(posts, authors);

            const pushedDown = await posts.join(spec, authors);
            const hashed = await viaHashJoin.call(posts, spec, authors);

            switch (comparisonFor(spec)) {
              case "ordered": {
                expect(shape(pushedDown)).toEqual(shape(hashed));
                // Not just the pairing: a strategy that returns the right rows
                // with a column missing or a value round-tripped differently is
                // the same wrong answer one layer down.
                expect(pushedDown).toEqual(hashed);
                break;
              }
              case "set": {
                expect(shape(pushedDown).sort()).toEqual(shape(hashed).sort());
                expect(sortRows(pushedDown)).toEqual(sortRows(hashed));
                break;
              }
              case "window": {
                const whole = shape(
                  await posts.join({ ...spec, limit: undefined, offset: undefined }, authors)
                );
                // WHICH rows a window over an undefined order selects is not
                // determined, so the two are not held to the same ones — that
                // is what a columnar backend fails while behaving correctly.
                // Two things are determined. How many rows come back, measured
                // against the unwindowed join rather than against each other:
                // agreeing on a wrong count is still wrong, and a strategy that
                // bounded its left read instead of the joined rows gets it
                // wrong. And that every row returned is one the unwindowed join
                // produced, counted WITH its repeats, so a duplicated row is
                // caught rather than passing as a member.
                //
                // That the two agree on the unwindowed rows at all is asserted
                // by the "set" comparison, which the same axis sweep reaches
                // with this spec's limit and offset dropped.
                const expectedLength = windowLength(whole.length, spec);
                expect(shape(pushedDown)).toHaveLength(expectedLength);
                expect(shape(hashed)).toHaveLength(expectedLength);
                expect(multisetRemainder(shape(pushedDown), whole)).toEqual([]);
                expect(multisetRemainder(shape(hashed), whole)).toEqual([]);
                break;
              }
            }
          } finally {
            await posts.deleteAll();
            await authors.deleteAll();
            posts.destroy?.();
            authors.destroy?.();
          }
        },
        opts.timeout
      );
    }
  });
}
