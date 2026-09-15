/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Sqlite, SqliteTabularStorage } from "@workglow/sqlite/storage";
import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";
import { runTabularMigrationContract } from "@workglow/test-contract/tabular-migrations";

runTabularMigrationContract({
  name: "SQLite",
  enforcesDdl: true,
  persistentBookkeeping: true,
  factory: async () => {
    await Sqlite.init();
    const db = new Sqlite.Database(":memory:");

    // Each it-block creates its own migrations array reference. We detect
    // "same it-block, second makeStorage call" via reference equality on the
    // migrations array. When the reference matches the previous call, we reuse
    // the same table so bookkeeping persists (required by
    // incrementalApplication and failedMigrationNotRecorded). Otherwise we
    // DROP the previous table and start fresh.
    let tableSeq = 0;
    let lastMigrationsRef: ReadonlyArray<ITabularMigration> | undefined;
    let currentTableName: string = "users_0";
    let prePopulatedForCurrentTable = false;

    return {
      makeStorage: async (
        properties: Record<string, unknown>,
        migrations: ReadonlyArray<ITabularMigration>,
        preExistingRows?: ReadonlyArray<Record<string, unknown>>
      ): Promise<AnyTabularStorage> => {
        const sameMigrations = migrations === lastMigrationsRef;
        lastMigrationsRef = migrations;

        if (!sameMigrations) {
          // New it-block: drop old table + bookkeeping rows, use a fresh name.
          if (tableSeq > 0) {
            try {
              db.exec(`DROP TABLE IF EXISTS "${currentTableName}"`);
              db.exec(
                `DELETE FROM _storage_migrations WHERE component = 'tabular:${currentTableName}'`
              );
            } catch {
              // ignore if bookkeeping table doesn't exist yet
            }
          }
          tableSeq++;
          currentTableName = `users_${tableSeq}`;
          prePopulatedForCurrentTable = false;
        }

        // Pre-populate once per table so the migrator sees "old" data on first run.
        if (!prePopulatedForCurrentTable && preExistingRows && preExistingRows.length > 0) {
          // Build v0 properties from the pre-existing row keys. For columns
          // that exist in the target schema, reuse the target type so that
          // SQL column types match. For columns not in the target (e.g., a
          // column being dropped or renamed), fall back to TEXT / string.
          const v0Properties: Record<string, unknown> = {};
          for (const k of Object.keys(preExistingRows[0])) {
            v0Properties[k] = (properties as Record<string, unknown>)[k] ?? { type: "string" };
          }
          const v0 = new SqliteTabularStorage(
            db,
            currentTableName,
            {
              type: "object",
              properties: v0Properties,
              required: Object.keys(v0Properties),
              additionalProperties: false,
            } as any,
            ["id"] as const
          );
          await v0.setupDatabase();
          for (const r of preExistingRows) {
            await (v0 as any).put(r);
          }
          prePopulatedForCurrentTable = true;
        }

        const storage = new SqliteTabularStorage(
          db,
          currentTableName,
          {
            type: "object",
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
          } as any,
          ["id"] as const,
          [],
          "if-missing",
          migrations as ReadonlyArray<ITabularMigration>
        );
        await storage.setupDatabase();
        return storage as unknown as AnyTabularStorage;
      },
      dispose: async () => {
        db.close();
      },
    };
  },
});
