/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from "vitest";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "../types";

export function addColumnBlock(
  _opts: TabularMigrationContractOpts,
  getHandle: () => TabularMigrationContractHandle
): void {
  it("addColumn: existing rows survive; new column readable", async () => {
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
      [{ id: "u1", name: "alice" }]
    );
    const row = (await storage.get({ id: "u1" })) as
      | { id: string; name: string; archived?: boolean | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("u1");
    expect(row!.archived ?? null).toBeNull();
  });
}
