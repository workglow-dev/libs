/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function failedMigrationNotRecordedBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("a failed migration is not recorded; subsequent run can succeed", async () => {
    let failOnFirst = true;
    const migrations = [
      {
        version: 1,
        ops: [
          {
            kind: "backfill" as const,
            transform: (row: Record<string, unknown>) => {
              if (failOnFirst) {
                failOnFirst = false;
                throw new Error("boom");
              }
              return row;
            },
          },
        ],
      },
    ];
    await expect(
      getHandle().makeStorage({ id: { type: "string" } }, migrations, [{ id: "u1" }])
    ).rejects.toThrow(/boom/);

    const storage = await getHandle().makeStorage({ id: { type: "string" } }, migrations, [
      { id: "u1" },
    ]);
    expect(await storage.size()).toBe(1);
  });
}
