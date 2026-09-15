/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function dropColumnBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("dropColumn: column removed; existing rows preserved (sans column)", async () => {
    const storage = await getHandle().makeStorage(
      { id: { type: "string" }, name: { type: "string" } },
      [
        {
          version: 1,
          ops: [{ kind: "dropColumn", name: "removed_field" }],
        },
      ],
      [{ id: "u1", name: "alice", removed_field: "old" }]
    );
    const row = (await storage.get({ id: "u1" })) as
      | { id: string; name: string; removed_field?: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("alice");
    expect((row as Record<string, unknown>).removed_field).toBeUndefined();
  });
}
