/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import "fake-indexeddb/auto";

import type { IndexedDbUpgradeContext } from "@workglow/indexeddb/storage";
import { IndexedDbMigrationRunner } from "@workglow/indexeddb/storage";
import { setLogger, uuid4 } from "@workglow/util";
import { describe } from "vitest";

import { getTestingLogger } from "@workglow/util/test";
import type { BuildMigrationFn } from "@workglow/test-contract/storage-migrations";
import { runMigrationRunnerContract } from "@workglow/test-contract/storage-migrations";

// IndexedDB upgrade transactions auto-commit when control returns to the
// event loop, so migration `up()` callbacks must be synchronous. Callers
// that pass `recorder.record(...)` synchronously are safe; the contract
// suite's recorder is in-memory and synchronous, so this is fine.
const buildMigration: BuildMigrationFn<IndexedDbUpgradeContext> = (
  component,
  version,
  recorder,
  options
) => ({
  component,
  version,
  description: `idb migration v${version}`,
  up: (ctx) => {
    if (options?.probeName) {
      ctx.db.createObjectStore(options.probeName);
      throw new Error(`idb migration v${version} failed (synthetic, after probe creation)`);
    }
    if (options?.fail) throw new Error(`idb migration v${version} failed (synthetic)`);
    recorder.record(component, version);
  },
});

describe("IndexedDbMigrationRunner", () => {
  setLogger(getTestingLogger());

  runMigrationRunnerContract<IndexedDbUpgradeContext>({
    name: "IndexedDB",
    timeout: 5_000,
    factory: async () => {
      const dbName = `idb_migration_test_${uuid4().replace(/-/g, "_")}`;
      return {
        createRunner: async () => new IndexedDbMigrationRunner(dbName),
        buildMigration,
        probeExists: async (name: string) => {
          return new Promise<boolean>((resolve, reject) => {
            const req = indexedDB.open(dbName);
            req.onsuccess = () => {
              const db = req.result;
              const exists = db.objectStoreNames.contains(name);
              db.close();
              resolve(exists);
            };
            req.onerror = () => reject(req.error);
          });
        },
        dispose: async () => {
          await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(dbName);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
          });
        },
      };
    },
  });
});
