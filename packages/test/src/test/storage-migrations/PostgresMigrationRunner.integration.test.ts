/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@workglow/postgres/storage";
import { PostgresMigrationRunner } from "@workglow/postgres/storage";
import { setLogger } from "@workglow/util";
import { describe } from "vitest";

import { getTestingLogger } from "@workglow/util/test";
import type { BuildMigrationFn } from "@workglow/test-contract/storage-migrations";
import { runMigrationRunnerContract } from "@workglow/test-contract/storage-migrations";

const buildMigration: BuildMigrationFn<Pool> = (component, version, recorder, options) => ({
  component,
  version,
  description: `pg migration v${version}`,
  up: async (pool) => {
    if (options?.probeName) {
      await pool.query(`CREATE TABLE ${options.probeName} (id INTEGER)`);
      throw new Error(`pg migration v${version} failed (synthetic, after probe creation)`);
    }
    if (options?.fail) throw new Error(`pg migration v${version} failed (synthetic)`);
    recorder.record(component, version);
  },
});

describe("PostgresMigrationRunner", () => {
  setLogger(getTestingLogger());

  // Each contract suite invocation owns its own PGlite instance — matches
  // the SQLite shim's "fresh DB per factory() call" pattern so the
  // bookkeeping table starts empty and no state bleeds between describes.
  runMigrationRunnerContract<Pool>({
    name: "Postgres",
    timeout: 30_000,
    factory: async () => {
      const pglite = new PGlite();
      const db = pglite as unknown as Pool;
      return {
        createRunner: async () => new PostgresMigrationRunner(db),
        buildMigration,
        probeExists: async (name: string) => {
          const result = await db.query<{ exists: boolean }, [string]>(
            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
            [name]
          );
          return result.rows[0]?.exists === true;
        },
        dispose: async () => {
          await pglite.close();
        },
      };
    },
  });
});
