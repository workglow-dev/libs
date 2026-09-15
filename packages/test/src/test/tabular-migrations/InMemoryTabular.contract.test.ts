/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";
import { InMemoryTabularStorage } from "@workglow/storage";
import { runTabularMigrationContract } from "@workglow/test-contract/tabular-migrations";

runTabularMigrationContract({
  name: "InMemory",
  enforcesDdl: false,
  // InMemory applier bookkeeping is per-instance and not shared across
  // makeStorage calls, so incrementalApplication / failedMigrationNotRecorded
  // cannot be reliably exercised. Skip those blocks.
  persistentBookkeeping: false,
  factory: async () => {
    return {
      makeStorage: async (
        properties: Record<string, unknown>,
        migrations: ReadonlyArray<ITabularMigration>,
        preExistingRows?: ReadonlyArray<Record<string, unknown>>
      ): Promise<AnyTabularStorage> => {
        const schema = {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        } as const;

        // Fresh storage per call; each assertion is isolated.
        const storage = new InMemoryTabularStorage(
          schema as any,
          ["id"] as const,
          [],
          "if-missing",
          migrations as ReadonlyArray<ITabularMigration>,
          "inmemory"
        );

        // Pre-populate rows before migrations run so the migrator sees the "old" data.
        if (preExistingRows && preExistingRows.length > 0) {
          for (const row of preExistingRows) {
            await (storage as any).put(row);
          }
        }

        await storage.setupDatabase();
        return storage as unknown as AnyTabularStorage;
      },
      dispose: async () => {
        // Nothing to clean up for in-memory.
      },
    };
  },
});
