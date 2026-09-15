/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Sqlite, SqliteMigrationRunner } from "@workglow/sqlite/storage";
import { setLogger } from "@workglow/util";
import { describe } from "vitest";

import { getTestingLogger } from "@workglow/util/test";
import type { BuildMigrationFn } from "@workglow/test-contract/storage-migrations";
import { runMigrationRunnerContract } from "@workglow/test-contract/storage-migrations";

const buildMigration: BuildMigrationFn<Sqlite.Database> = (
  component,
  version,
  recorder,
  options
) => ({
  component,
  version,
  description: `sqlite migration v${version}`,
  up: async (sqliteDb) => {
    if (options?.probeName) {
      sqliteDb.exec(`CREATE TABLE ${options.probeName} (id INTEGER)`);
      throw new Error(`sqlite migration v${version} failed (synthetic, after probe creation)`);
    }
    if (options?.fail) throw new Error(`sqlite migration v${version} failed (synthetic)`);
    recorder.record(component, version);
  },
});

describe("SqliteMigrationRunner", async () => {
  await Sqlite.init();
  setLogger(getTestingLogger());

  // Each contract suite invocation owns its own in-memory database so the
  // bookkeeping table starts clean.
  runMigrationRunnerContract<Sqlite.Database>({
    name: "SQLite",
    timeout: 5_000,
    factory: async () => {
      const db = new Sqlite.Database(":memory:");
      return {
        createRunner: async () => new SqliteMigrationRunner(db),
        buildMigration,
        probeExists: async (name: string) => {
          const stmt = db.prepare<[string], { name: string }>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
          );
          return stmt.get(name) !== undefined;
        },
        dispose: async () => {
          db.close();
        },
      };
    },
  });
});
