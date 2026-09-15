/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function incrementalApplicationBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("running migrations twice is idempotent (each version applied once)", async () => {
    let backfillCalls = 0;
    const migrations = [
      {
        version: 1,
        ops: [
          {
            kind: "backfill" as const,
            transform: (row: Record<string, unknown>) => {
              backfillCalls++;
              return row;
            },
          },
        ],
      },
    ];
    await getHandle().makeStorage({ id: { type: "string" }, n: { type: "integer" } }, migrations, [
      { id: "r1", n: 1 },
    ]);
    const firstCount = backfillCalls;
    await getHandle().makeStorage({ id: { type: "string" }, n: { type: "integer" } }, migrations, [
      { id: "r1", n: 1 },
    ]);
    expect(backfillCalls).toBe(firstCount);
  });
}
