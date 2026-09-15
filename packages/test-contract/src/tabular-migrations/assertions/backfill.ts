/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function backfillBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("backfill: every existing row is rewritten", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, n: i }));
    const storage = await getHandle().makeStorage(
      { id: { type: "string" }, n: { type: "integer" } },
      [
        {
          version: 1,
          ops: [
            {
              kind: "backfill",
              batchSize: 7,
              transform: (row) => ({ ...row, n: (row.n as number) * 2 }),
            },
          ],
        },
      ],
      rows
    );
    const all = (await storage.getAll()) ?? [];
    const r3 = all.find((r) => (r as { id: string }).id === "r3") as { n: number } | undefined;
    expect(r3).toBeDefined();
    expect(r3!.n).toBe(6);
    expect(all.length).toBe(30);
  });
}
