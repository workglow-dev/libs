/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";
import { FsFolderTabularStorage } from "@workglow/storage";
import type { TabularMigrationContractHandle } from "@workglow/test-contract/tabular-migrations";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The FsFolder handle for the tabular migration contract.
 *
 * Each it-block passes its own migrations array. A second `makeStorage` call with the
 * same array is the same it-block reopening its storage, so it gets the same directory
 * and bookkeeping persists (incrementalApplication and failedMigrationNotRecorded need
 * that); a new array rotates to a fresh directory.
 *
 * A call keeps the directory it chose in a local and records pre-population per
 * directory. Bun retries a failed test while the timed-out attempt may still be
 * running: reading shared "current directory" state after an `await` let that attempt
 * follow the retry into its directory, apply the migration there before the rows were
 * written, and the retry's backfill was then skipped as already applied.
 */
export async function createFsFolderContractHandle(): Promise<TabularMigrationContractHandle> {
  const rootDir = mkdtempSync(join(tmpdir(), "fsft-contract-"));
  let dirSeq = 0;
  let lastMigrationsRef: ReadonlyArray<ITabularMigration> | undefined;
  let currentDir: string = join(rootDir, "d0");
  const prePopulatedDirs = new Set<string>();
  mkdirSync(currentDir, { recursive: true });

  return {
    makeStorage: async (
      properties: Record<string, unknown>,
      migrations: ReadonlyArray<ITabularMigration>,
      preExistingRows?: ReadonlyArray<Record<string, unknown>>
    ): Promise<AnyTabularStorage> => {
      if (migrations !== lastMigrationsRef) {
        dirSeq++;
        currentDir = join(rootDir, `d${dirSeq}`);
        mkdirSync(currentDir, { recursive: true });
      }
      lastMigrationsRef = migrations;
      // Everything below awaits; nothing after this line reads the shared state.
      const dir = currentDir;

      const schema = {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      } as const;

      // Pre-populate once per directory so the migrator sees "old" data on first run.
      if (!prePopulatedDirs.has(dir) && preExistingRows && preExistingRows.length > 0) {
        prePopulatedDirs.add(dir);
        const v0 = new FsFolderTabularStorage(dir, schema as any, ["id"] as const);
        await v0.setupDatabase();
        for (const r of preExistingRows) {
          await (v0 as any).put(r);
        }
      }

      const storage = new FsFolderTabularStorage(
        dir,
        schema as any,
        ["id"] as const,
        [],
        "if-missing",
        migrations as ReadonlyArray<ITabularMigration>
      );
      await storage.setupDatabase();
      return storage as unknown as AnyTabularStorage;
    },
    dispose: async () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
