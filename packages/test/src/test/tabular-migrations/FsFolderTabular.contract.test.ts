/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";
import { FsFolderTabularStorage } from "@workglow/storage";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTabularMigrationContract } from "@workglow/test-contract/tabular-migrations";

runTabularMigrationContract({
  name: "FsFolder",
  enforcesDdl: false,
  persistentBookkeeping: true,
  factory: async () => {
    // Root temp dir for this factory. Subdirectories are rotated per it-block.
    const rootDir = mkdtempSync(join(tmpdir(), "fsft-contract-"));

    // Each it-block creates its own migrations array reference. We detect
    // "same it-block, second makeStorage call" via reference equality on the
    // migrations array. When the reference matches the previous call, we reuse
    // the same subdirectory so bookkeeping persists (required by
    // incrementalApplication and failedMigrationNotRecorded). Otherwise we
    // rotate to a fresh subdirectory.
    let dirSeq = 0;
    let lastMigrationsRef: ReadonlyArray<ITabularMigration> | undefined;
    let currentDir: string = join(rootDir, "d0");
    let prePopulatedForCurrentDir = false;
    mkdirSync(currentDir, { recursive: true });

    return {
      makeStorage: async (
        properties: Record<string, unknown>,
        migrations: ReadonlyArray<ITabularMigration>,
        preExistingRows?: ReadonlyArray<Record<string, unknown>>
      ): Promise<AnyTabularStorage> => {
        const sameMigrations = migrations === lastMigrationsRef;
        lastMigrationsRef = migrations;

        if (!sameMigrations) {
          // New it-block: rotate to a fresh subdirectory.
          dirSeq++;
          currentDir = join(rootDir, `d${dirSeq}`);
          mkdirSync(currentDir, { recursive: true });
          prePopulatedForCurrentDir = false;
        }

        const schema = {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        } as const;

        // Pre-populate once per directory so the migrator sees "old" data on first run.
        if (!prePopulatedForCurrentDir && preExistingRows && preExistingRows.length > 0) {
          const v0 = new FsFolderTabularStorage(currentDir, schema as any, ["id"] as const);
          await v0.setupDatabase();
          for (const r of preExistingRows) {
            await (v0 as any).put(r);
          }
          prePopulatedForCurrentDir = true;
        }

        const storage = new FsFolderTabularStorage(
          currentDir,
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
  },
});
