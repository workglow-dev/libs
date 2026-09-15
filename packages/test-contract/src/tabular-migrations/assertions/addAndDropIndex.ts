/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function addAndDropIndexBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("addIndex / dropIndex: query still returns correct rows", async () => {
    const storage = await getHandle().makeStorage(
      { id: { type: "string" }, name: { type: "string" } },
      [
        {
          version: 1,
          ops: [
            { kind: "addIndex", name: "idx_name", columns: ["name"] },
            { kind: "dropIndex", name: "idx_name" },
          ],
        },
      ],
      [
        { id: "u1", name: "alice" },
        { id: "u2", name: "bob" },
      ]
    );
    const rows = (await storage.query({ name: "alice" })) ?? [];
    expect(rows.map((r) => (r as { id: string }).id)).toEqual(["u1"]);
  });
}
