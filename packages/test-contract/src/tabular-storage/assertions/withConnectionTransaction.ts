/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConnectionReentryError,
  withConnectionTransaction,
  type ITabularStorage,
} from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "../fixtures";
import { itExpectFail } from "../../itExpectFail";
import type { TabularStorageContractOpts } from "../types";

export function withConnectionTransactionBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("withConnectionTransaction") ? itExpectFail : it;

  describe.skipIf(
    !opts.capabilities.supportsTransactions || opts.createSiblingStorage === undefined
  )("withConnectionTransaction", () => {
    let primary: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;
    let sibling: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;
    let outsider: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(async () => {
      primary = await opts.createStorage();
      await primary.setupDatabase?.();
      sibling = await opts.createSiblingStorage!(primary);
      await sibling.setupDatabase?.();
      outsider = await opts.createSiblingStorage!(primary);
      await outsider.setupDatabase?.();
    });

    afterEach(async () => {
      await outsider?.deleteAll();
      outsider?.destroy?.();
      await sibling?.deleteAll();
      sibling?.destroy?.();
      await primary?.deleteAll();
      primary?.destroy?.();
      // Siblings share `primary`'s handle, so they are released with it —
      // release last, after every storage on that handle is destroyed.
      await opts.releaseStorage?.(primary);
    });

    itImpl(
      "commits writes across two tables",
      async () => {
        await withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "from-a", type: "x", option: "va", success: true });
          await sibling.put({ name: "from-b", type: "x", option: "vb", success: true });
        });
        expect(await primary.get({ name: "from-a", type: "x" })).toMatchObject({ option: "va" });
        expect(await sibling.get({ name: "from-b", type: "x" })).toMatchObject({ option: "vb" });
      },
      opts.timeout
    );

    itImpl(
      "rolls back both tables when the callback throws",
      async () => {
        await primary.put({ name: "kept", type: "x", option: "base", success: true });

        await expect(
          withConnectionTransaction([primary, sibling], async () => {
            await primary.put({ name: "from-a", type: "x", option: "va", success: true });
            await sibling.put({ name: "from-b", type: "x", option: "vb", success: true });
            throw new Error("forced rollback");
          })
        ).rejects.toThrow("forced rollback");

        expect(await primary.get({ name: "kept", type: "x" })).toBeDefined();
        expect(await primary.get({ name: "from-a", type: "x" })).toBeUndefined();
        expect(await sibling.get({ name: "from-b", type: "x" })).toBeUndefined();
      },
      opts.timeout
    );

    itImpl(
      "does not refuse an unrelated concurrent caller",
      async () => {
        // Issued from outside the transaction body, so it is not an async
        // descendant and its write cannot escape the BEGIN. Refusing it would
        // land the error in a caller that did nothing wrong. Whether it waits
        // for COMMIT (single-session backends chain) or runs at once (a pool
        // hands it another client) is a backend detail — that it completes is
        // not.
        let releaseBody: () => void = () => {};
        const bodyCanFinish = new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        let signalStarted: () => void = () => {};
        const bodyStarted = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });

        const txPromise = withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "enlisted", type: "x", option: "ok", success: true });
          signalStarted();
          await bodyCanFinish;
        });
        await bodyStarted;

        let outsiderError: unknown;
        const concurrent = outsider
          .put({ name: "concurrent", type: "x", option: "yes", success: true })
          .catch((err: unknown) => {
            outsiderError = err;
          });

        releaseBody();
        await txPromise;
        await concurrent;

        expect(outsiderError).toBeUndefined();
        expect(await outsider.get({ name: "concurrent", type: "x" })).toBeDefined();
        expect(await primary.get({ name: "enlisted", type: "x" })).toBeDefined();
      },
      opts.timeout
    );

    itImpl(
      "does not refuse a concurrent transaction whose participant set merely differs",
      async () => {
        // Two units of work on one handle, neither inside the other, opening
        // transactions over overlapping-but-unequal participant sets — the
        // shape any concurrent sweep produces. On a single-session backend only
        // one BEGIN can be open at a time, so the second waits; on a pool it
        // takes another client. Either way it must not be refused.
        let releaseFirst: () => void = () => {};
        const firstCanFinish = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let signalStarted: () => void = () => {};
        const firstStarted = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });

        const first = withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "first", type: "x", option: "one", success: true });
          signalStarted();
          await firstCanFinish;
        });
        await firstStarted;

        let secondError: unknown;
        const second = withConnectionTransaction([sibling, outsider], async () => {
          await outsider.put({ name: "second", type: "x", option: "two", success: true });
        }).catch((err: unknown) => {
          secondError = err;
        });

        releaseFirst();
        await first;
        await second;

        expect(secondError).toBeUndefined();
        expect(await primary.get({ name: "first", type: "x" })).toBeDefined();
        expect(await outsider.get({ name: "second", type: "x" })).toBeDefined();
      },
      opts.timeout
    );

    itImpl(
      "does not show uncommitted rows to a concurrent reader",
      async () => {
        // A connection transaction takes the CONNECTION's chain slot and flags
        // its participants; reads used to take only the per-instance mutex,
        // which the transaction never holds. The two locks never intersected,
        // so on a single-session backend a concurrent read ran on the very
        // session sitting inside the open BEGIN and returned rows the ROLLBACK
        // below erases — a caller could act on a ban, a balance or a lock that
        // never existed.
        //
        // How a backend keeps the reader honest is its business: the
        // single-session ones queue the read behind COMMIT, a real pool hands
        // it another client and answers at once. Both must report the
        // committed value, which is the pre-transaction one here.
        await primary.put({ name: "iso", type: "x", option: "before", success: true });

        let releaseBody: () => void = () => {};
        const bodyCanFinish = new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        let signalStarted: () => void = () => {};
        const bodyStarted = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });

        let rollbackError: unknown;
        const txPromise = withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "iso", type: "x", option: "dirty", success: true });
          signalStarted();
          await bodyCanFinish;
          throw new Error("forced rollback");
        }).catch((err: unknown) => {
          rollbackError = err;
        });
        await bodyStarted;

        // Issued from the test's own task, so it is not an async descendant of
        // the body — the caller the transaction is supposed to be invisible to.
        const readPromise = primary.get({ name: "iso", type: "x" });
        // Long enough that a read which is NOT held back has finished.
        await new Promise((resolve) => setTimeout(resolve, 25));

        releaseBody();
        await txPromise;
        expect((rollbackError as Error | undefined)?.message).toBe("forced rollback");

        expect(await readPromise).toMatchObject({ option: "before" });
        expect(await primary.get({ name: "iso", type: "x" })).toMatchObject({ option: "before" });
      },
      opts.timeout
    );

    itImpl(
      "does not show uncommitted rows to a concurrent pushed-down join",
      async () => {
        // The single-statement join path used to take only the per-instance
        // mutex, so once every other read moved onto the connection chain it
        // was the one entry point left reading off the session inside the open
        // BEGIN — and the worst one to leave there, since it reads two tables
        // in a single statement.
        //
        // Both storages are enlisted, so the join is not handed to the hash
        // fallback (which reads through the already-guarded `query`) and the
        // pushdown is what actually runs.
        await primary.put({ name: "join-iso", type: "j", option: "before", success: true });
        await sibling.put({ name: "join-key", type: "j", option: "rhs", success: true });

        let releaseBody: () => void = () => {};
        const bodyCanFinish = new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        let signalStarted: () => void = () => {};
        const bodyStarted = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });

        let rollbackError: unknown;
        const txPromise = withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "join-iso", type: "j", option: "dirty", success: true });
          signalStarted();
          await bodyCanFinish;
          throw new Error("forced rollback");
        }).catch((err: unknown) => {
          rollbackError = err;
        });
        await bodyStarted;

        // Issued from the test's own task, so it is not an async descendant of
        // the body — the caller the transaction is supposed to be invisible to.
        const joinPromise = primary.join(
          { type: "inner", on: [{ left: "type", right: "type" }] },
          sibling
        );
        // Long enough that a join which is NOT held back has finished.
        await new Promise((resolve) => setTimeout(resolve, 25));

        releaseBody();
        await txPromise;
        expect((rollbackError as Error | undefined)?.message).toBe("forced rollback");

        const rows = await joinPromise;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.left).toMatchObject({ name: "join-iso", option: "before" });
        expect(rows[0]!.right).toMatchObject({ name: "join-key", option: "rhs" });
      },
      opts.timeout
    );

    itImpl(
      "throws sibling-op for a storage that was not enlisted",
      async () => {
        let error: unknown;
        await withConnectionTransaction([primary, sibling], async () => {
          await primary.put({ name: "enlisted", type: "x", option: "ok", success: true });
          try {
            await outsider.put({ name: "outsider", type: "x", option: "no", success: true });
          } catch (err) {
            error = err;
          }
        });

        expect(error).toBeInstanceOf(ConnectionReentryError);
        expect((error as ConnectionReentryError).mode).toBe("sibling-op");
        expect(await outsider.get({ name: "outsider", type: "x" })).toBeUndefined();
        expect(await primary.get({ name: "enlisted", type: "x" })).toBeDefined();
      },
      opts.timeout
    );
  });
}
