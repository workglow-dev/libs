/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { IndexedDbTabularStorage } from "@workglow/indexeddb/storage";
import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";
import "fake-indexeddb/auto";
import { runTabularMigrationContract } from "@workglow/test-contract/tabular-migrations";

let factoryCounter = 0;

runTabularMigrationContract({
  name: "IndexedDB",
  enforcesDdl: false,
  persistentBookkeeping: true,
  factory: async () => {
    const factoryId = ++factoryCounter;

    // Each it-block creates its own migrations array reference. We detect
    // "same it-block, second makeStorage call" via reference equality on the
    // migrations array. When the reference matches the previous call, we reuse
    // the same DB name so bookkeeping persists (required by
    // incrementalApplication and failedMigrationNotRecorded). Otherwise we
    // rotate to a fresh DB name.
    let dbSeq = 0;
    let lastMigrationsRef: ReadonlyArray<ITabularMigration> | undefined;
    let currentDbName: string = `idb_contract_f${factoryId}_0`;
    let prePopulatedForCurrentDb = false;

    return {
      makeStorage: async (
        properties: Record<string, unknown>,
        migrations: ReadonlyArray<ITabularMigration>,
        preExistingRows?: ReadonlyArray<Record<string, unknown>>
      ): Promise<AnyTabularStorage> => {
        const sameMigrations = migrations === lastMigrationsRef;
        lastMigrationsRef = migrations;

        if (!sameMigrations) {
          // New it-block: rotate to a fresh DB name.
          dbSeq++;
          currentDbName = `idb_contract_f${factoryId}_${dbSeq}`;
          prePopulatedForCurrentDb = false;
        }

        const schema = {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        } as const;

        // Pre-populate once per DB so the migrator sees "old" data on first run.
        if (!prePopulatedForCurrentDb && preExistingRows && preExistingRows.length > 0) {
          const v0 = new IndexedDbTabularStorage(currentDbName, schema as any, ["id"] as const);
          await v0.setupDatabase();
          for (const r of preExistingRows) {
            await (v0 as any).put(r);
          }
          prePopulatedForCurrentDb = true;
        }

        const storage = new IndexedDbTabularStorage(
          currentDbName,
          schema as any,
          ["id"] as const,
          [],
          {},
          "if-missing",
          migrations as ReadonlyArray<ITabularMigration>
        );
        await storage.setupDatabase();
        return storage as unknown as AnyTabularStorage;
      },
      dispose: async () => {
        // fake-indexeddb cleans up automatically.
      },
    };
  },
});
