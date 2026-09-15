/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function renameColumnBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("renameColumn: data preserved under new name", async () => {
    const storage = await getHandle().makeStorage(
      { id: { type: "string" }, state: { type: "string" } },
      [
        {
          version: 1,
          ops: [{ kind: "renameColumn", from: "status", to: "state" }],
        },
      ],
      [{ id: "u1", status: "active" }]
    );
    const row = (await storage.get({ id: "u1" })) as { id: string; state: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.state).toBe("active");
  });
}
