/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyTabularStorage, ITabularMigration } from "@workglow/storage";

export interface TabularMigrationContractHandle {
  /**
   * Build a fresh storage at the given target schema, with the supplied
   * migrations and an optional pre-populated set of rows. Calls
   * `setupDatabase` before returning.
   *
   * The schema's properties at minimum include `id: string` (PK) plus
   * whatever extra columns the test's migration ops mention.
   */
  makeStorage(
    properties: Record<string, unknown>,
    migrations: ReadonlyArray<ITabularMigration>,
    preExistingRows?: ReadonlyArray<Record<string, unknown>>
  ): Promise<AnyTabularStorage>;
  dispose(): Promise<void>;
}

export interface TabularMigrationContractOpts {
  readonly name: string;
  readonly factory: () => Promise<TabularMigrationContractHandle>;
  readonly skip?: boolean;
  readonly timeout?: number;
  /** True for SQL backends: DDL is enforced; addColumn produces a real column. */
  readonly enforcesDdl: boolean;
  /** True for FsFolder, IDB, SQLite-on-disk: bookkeeping survives restart. */
  readonly persistentBookkeeping?: boolean;
}
