/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function freshDbFastPathBlock(
  opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("fresh DB: backfill is NOT executed; bookkeeping marks all applied", async () => {
    let transformCalls = 0;
    const storage = await getHandle().makeStorage(
      { id: { type: "string" }, n: { type: "integer" } },
      [
        {
          version: 1,
          ops: [
            {
              kind: "backfill",
              transform: (row) => {
                transformCalls++;
                return row;
              },
            },
          ],
        },
      ],
      [] // no pre-existing rows -> fresh DB
    );
    expect(transformCalls).toBe(0);
    expect(await storage.size()).toBe(0);
  });

  // Regression test for the fresh-DB fast path on SQL backends. If the
  // orchestrator's freshTable signal is wired up correctly, addColumn for
  // a column that already exists in the target schema must NOT run as a
  // real ALTER TABLE — which would throw "duplicate column" — because
  // the migration is recorded as already-applied without executing ops.
  // Only meaningful on backends that enforce DDL (i.e. SQL ones).
  if (opts.enforcesDdl) {
    it("fresh DB: addColumn against target-schema does NOT execute (fast path)", async () => {
      // The target schema already includes `archived`. A v1 migration that
      // would `ALTER TABLE … ADD COLUMN archived` should be marked applied
      // without running on a brand-new DB.
      const storage = await getHandle().makeStorage(
        {
          id: { type: "string" },
          name: { type: "string" },
          archived: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        },
        [
          {
            version: 1,
            ops: [
              {
                kind: "addColumn",
                name: "archived",
                schema: { anyOf: [{ type: "boolean" }, { type: "null" }] },
              },
            ],
          },
        ],
        [] // no pre-existing rows -> fresh DB
      );
      // If the fast path is broken, makeStorage above throws on the
      // duplicate-column error and we never reach here. Reaching this
      // assertion is itself the proof.
      expect(await storage.size()).toBe(0);
    });
  }
}
