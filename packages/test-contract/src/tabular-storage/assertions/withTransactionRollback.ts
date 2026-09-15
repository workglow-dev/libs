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

export function withTransactionRollbackBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("withTransactionRollback") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsTransactions)("withTransactionRollback", () => {
    let storage: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>;

    beforeEach(async () => {
      storage = await opts.createStorage();
      await storage.setupDatabase?.();
    });

    afterEach(async () => {
      await storage.deleteAll();
      storage.destroy?.();
      await opts.releaseStorage?.(storage);
    });

    itImpl(
      "rolls back writes when callback throws",
      async () => {
        const baseline = { name: "before", type: "tx", option: "base", success: true };
        await storage.put(baseline);

        await expect(
          storage.withTransaction(async (tx) => {
            await tx.put({ name: "inside", type: "tx", option: "intra", success: false });
            throw new Error("forced rollback");
          })
        ).rejects.toBeDefined();

        const intraRow = await storage.get({ name: "inside", type: "tx" });
        expect(intraRow).toBeUndefined();

        const beforeRow = await storage.get({ name: "before", type: "tx" });
        expect(beforeRow).toBeDefined();
        expect(beforeRow?.option).toBe("base");
      },
      opts.timeout
    );
  });
}
