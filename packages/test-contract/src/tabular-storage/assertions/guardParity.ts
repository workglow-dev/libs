/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

type Storage = ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

/**
 * What one call did, reduced to what can be compared across the two paths.
 *
 * Only the error's class and message, not the instance: the two calls throw
 * from the same guard but not the same throw site, and identity would make the
 * comparison vacuous.
 */
type Outcome =
  | { readonly kind: "returned" }
  | { readonly kind: "threw"; readonly name: string; readonly message: string };

async function outcomeOf(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    await call();
    return { kind: "returned" };
  } catch (error) {
    return {
      kind: "threw",
      name: error instanceof Error ? error.constructor.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

interface GuardParityCase {
  /** The public method, which is also the name the `tx` handle is called by. */
  readonly method: string;
  /** What makes the input bad, phrased as the test name reads it. */
  readonly label: string;
  readonly run: (target: Storage) => Promise<unknown>;
}

/**
 * The inputs a guard is supposed to reject, one per guard rather than one per
 * method: `queryIndex` has two ways to fail `validateSelect` and both are here,
 * because a fix that reinstates one and not the other is the same bug again.
 */
const CASES: readonly GuardParityCase[] = [
  {
    method: "getAll",
    label: "a limit of zero",
    run: (t) => t.getAll({ limit: 0 }),
  },
  {
    method: "getAll",
    label: "a negative offset",
    run: (t) => t.getAll({ offset: -1 }),
  },
  {
    method: "getPage",
    label: "a limit of zero",
    run: (t) => t.getPage({ limit: 0 }),
  },
  {
    method: "count",
    label: "empty criteria",
    run: (t) => t.count({}),
  },
  {
    method: "query",
    label: "an operator outside the allow-list",
    run: (t) => t.query({ name: { operator: "regex", value: "a" } } as never),
  },
  {
    method: "query",
    label: "a column that is not in the schema",
    run: (t) => t.query({ nope: "a" } as never),
  },
  {
    method: "query",
    label: "a list operator whose value is not an array",
    run: (t) => t.query({ name: { operator: "in", value: "a" } } as never),
  },
  {
    method: "queryPage",
    label: "empty criteria",
    run: (t) => t.queryPage({}, { limit: 5 }),
  },
  {
    method: "queryIndex",
    label: "an empty select",
    run: (t) => t.queryIndex({ name: "a" }, { select: [] } as never),
  },
  {
    method: "queryIndex",
    label: "a select column that is not in the schema",
    run: (t) => t.queryIndex({ name: "a" }, { select: ["nope"] } as never),
  },
  {
    method: "deleteSearch",
    label: "empty criteria",
    run: (t) => t.deleteSearch({}),
  },
  {
    method: "deleteSearch",
    label: "criteria that exclude nothing",
    run: (t) => t.deleteSearch({ option: { operator: "not-in", value: [] } } as never),
  },
  {
    method: "updateWhere",
    label: "a patch that rewrites a primary-key column",
    run: (t) => t.updateWhere({ name: "guard", type: "parity" }, { name: "moved" } as never),
  },
  {
    // Joined to itself, so the case needs no second storage and the guard is
    // reached on whichever path the planner picks: the pushdown validates in
    // `runSqlJoin`, the hash fallback in `BaseTabularStorage.join`.
    method: "join",
    label: "a join column that is not in the schema",
    run: (t) => t.join({ type: "inner", on: [{ left: "nope", right: "name" }] } as never, t),
  },
];

/**
 * Methods routed to a private implementation that no guard rejects an input
 * to, and why.
 *
 * Not an exemption list — a name here is a claim that the method was read and
 * has nothing to check, and the coverage assertion below is what forces the
 * claim to be made rather than skipped.
 */
const UNGUARDED: Readonly<Record<string, string>> = {
  put: "an entity is coerced against the schema, not rejected by a guard",
  putBulk: "as `put`",
  get: "a primary key, and a malformed one reads as a miss on every backend",
  getBulk: "as `get`",
  delete: "as `get`",
  deleteAll: "takes no arguments",
  size: "takes no arguments",
  getOffsetPage: "takes two numbers and the SQL backends validate neither",
};

/** The public method `_fooInternal` implements. */
function publicNameOf(internal: string): string | undefined {
  const match = /^_(.+)Internal$/.exec(internal);
  return match?.[1];
}

/**
 * Every method that reaches the database as a public wrapper over a private
 * `_fooInternal`, read off the instance rather than listed here.
 *
 * That split is where a guard has two places it could go, and the shape a
 * method arrives in when someone adds one — so asking the object which methods
 * have it is what makes a method added later show up without anyone
 * remembering this file exists.
 */
function routedMethods(storage: Storage): string[] {
  const found = new Set<string>();
  for (
    let proto: object | null = Object.getPrototypeOf(storage);
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const name = publicNameOf(key);
      if (name !== undefined && typeof (storage as never)[key] === "function") found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * A guard on a public method is a guard on the transaction path.
 *
 * It was not always. `withTransaction` used to hand its callback a Proxy that
 * resolved `tx.foo(...)` to `_fooInternal(...)` by name, skipping the public
 * method, so a check written on `foo` was silently absent from `tx.foo`. That
 * cost three fixes — `tx.deleteSearch({})` turning from a no-op into a `DELETE
 * FROM t WHERE` syntax error and criteria excluding nothing into a truncated
 * table; `tx.updateWhere` rewriting a row's identity where the same call
 * outside a transaction threw; `tx.getBulk([])` reaching DuckDB as `IN ()` —
 * and each could only restate the guard in the private method.
 *
 * `createTxView` now leaves the public methods in place and neutralizes only
 * the mutex, so `tx.foo(args)` runs `foo`. Parity is a property of the routing
 * rather than of anyone's diligence, and this block is what says so out loud:
 * every guard below is written once, on the public method, and asserted on both
 * paths, over a set of methods derived from the object rather than written down.
 */
export function guardParityBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("guardParity") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsTransactions || !opts.capabilities.supportsQuery)(
    "guardParity",
    () => {
      let storage: Storage;

      beforeEach(async () => {
        storage = await opts.createStorage();
        await storage.setupDatabase?.();
        await storage.put({ name: "guard", type: "parity", option: "base", success: true });
      });

      afterEach(async () => {
        await storage.deleteAll();
        storage.destroy?.();
        await opts.releaseStorage?.(storage);
      });

      for (const testCase of CASES) {
        itImpl(
          `${testCase.method} rejects ${testCase.label} the same way inside a transaction`,
          async () => {
            const direct = await outcomeOf(() => testCase.run(storage));

            let inside: Outcome | undefined;
            await storage.withTransaction(async (tx) => {
              // Captured rather than rethrown: a guard firing is the expected
              // result here, and letting it out would roll the transaction back
              // and hide which of the two paths differed.
              inside = await outcomeOf(() => testCase.run(tx as unknown as Storage));
            });

            expect(inside).toEqual(direct);
          },
          opts.timeout
        );
      }

      itImpl(
        "deleteSearch with empty criteria deletes nothing on either path",
        async () => {
          // The one case whose parity is a non-event: both paths return, and
          // the guard is only observable in the rows that are still there.
          await storage.deleteSearch({});
          await storage.withTransaction(async (tx) => {
            await tx.deleteSearch({});
          });

          expect(await storage.get({ name: "guard", type: "parity" })).toBeDefined();
        },
        opts.timeout
      );

      itImpl(
        "runs the public method on the transaction path, not only its implementation",
        async () => {
          // What every case above now rests on, asserted on its own so a
          // regression to name-based routing fails here first and says why.
          //
          // `getBulk` emits its event from the public method and nowhere else,
          // so observing the event through the `tx` handle is observing the
          // public method run — the guard-carrying half that resolving
          // `tx.getBulk` to `_getBulkInternal` used to skip.
          const emitted: Array<readonly unknown[]> = [];
          const listener = (keys: readonly unknown[]): void => {
            emitted.push(keys);
          };
          storage.on("getBulk", listener);
          try {
            await storage.withTransaction(async (tx) => {
              await (tx as unknown as Storage).getBulk([{ name: "guard", type: "parity" }]);
            });
          } finally {
            storage.off("getBulk", listener);
          }

          expect(emitted).toEqual([[{ name: "guard", type: "parity" }]]);
        },
        opts.timeout
      );

      itImpl(
        "states, for every method with a private implementation, what its guard is",
        async () => {
          // The ratchet. A method added later reaches the transaction path the
          // moment it exists, whether or not anyone thought about its guard —
          // and this is where that is noticed, rather than in the diff of the
          // commit that drops one.
          const covered = new Set(CASES.map((testCase) => testCase.method));
          const unstated = routedMethods(storage).filter(
            (method) => !covered.has(method) && UNGUARDED[method] === undefined
          );
          expect(unstated).toEqual([]);
        },
        opts.timeout
      );
    }
  );
}
