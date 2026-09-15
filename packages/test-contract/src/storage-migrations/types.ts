/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMigration, IMigrationRunner } from "@workglow/storage";

/**
 * Records each invocation of a migration's `up()` callback. The contract
 * suite uses this to verify which migrations actually ran (orthogonal to
 * the runner's own bookkeeping table).
 *
 * Caveat: the recorder reflects whether `up()` *executed*, not whether
 * its effects *persisted*. For backends that wrap `up()` in a transaction
 * (Postgres BEGIN/ROLLBACK; IndexedDB upgrade tx.abort), a migration whose
 * `up()` records and then throws has `recorder.calls` containing that
 * version even though the bookkeeping insert and any DDL were rolled back.
 * Use `runner.appliedVersions(component)` to check what *persisted*; use
 * the recorder to check what *ran*.
 */
export interface MigrationCallRecorder {
  readonly calls: ReadonlyArray<{ readonly component: string; readonly version: number }>;
  readonly record: (component: string, version: number) => void;
  readonly clear: () => void;
}

export function createMigrationCallRecorder(): MigrationCallRecorder {
  const calls: { component: string; version: number }[] = [];
  return {
    get calls() {
      return calls;
    },
    record: (component: string, version: number) => {
      calls.push({ component, version });
    },
    clear: () => {
      calls.length = 0;
    },
  };
}

export interface BuildMigrationOptions {
  /** When set, the migration's `up()` throws synchronously. */
  readonly fail?: boolean;
  /**
   * When set, `up()` first creates a probe schema element with this name
   * (a table for SQL backends, an object store for IDB) and then throws.
   * Used by the partial-schema assertion to check whether the runner rolls
   * DDL back on failure.
   */
  readonly probeName?: string;
}

/**
 * Adapter-supplied factory that constructs a migration of the right
 * shape for the underlying DB (Postgres pool, SQLite database, or
 * IndexedDb upgrade context). The returned migration's `up()` calls the
 * recorder unless `opts.fail` is true.
 */
export type BuildMigrationFn<DB> = (
  component: string,
  version: number,
  recorder: MigrationCallRecorder,
  opts?: BuildMigrationOptions
) => IMigration<DB>;

export interface MigrationContractHandle<DB> {
  readonly createRunner: () => Promise<IMigrationRunner<DB>>;
  readonly buildMigration: BuildMigrationFn<DB>;
  /**
   * Returns true iff a probe schema element with the given name currently
   * exists in the backing database. Required by the
   * `failedMigrationLeavesNoPartialSchema` assertion. Implementations
   * inspect the relevant catalog (`information_schema.tables`,
   * `sqlite_master`, `db.objectStoreNames`).
   */
  readonly probeExists: (name: string) => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}

/**
 * Closed string-literal union of contract assertions adapters can mark as
 * known failing. Adding a new assertion to the suite must extend this
 * union — that way a typo in `expectedFailures` becomes a TS error rather
 * than a silently-ignored entry.
 */
export type MigrationContractAssertion =
  | "appliesAndRecords"
  | "idempotentRun"
  | "incrementalApplication"
  | "failedMigrationNotRecorded"
  | "ensureBookkeepingIdempotent"
  | "concurrentRunsSerialize"
  | "failedMigrationLeavesNoPartialSchema";

export interface MigrationRunnerContractOpts<DB> {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  readonly factory: () => Promise<MigrationContractHandle<DB>>;
  /**
   * Names of contract assertions currently broken in this adapter; each
   * named test wraps with `itExpectFail`. The string-literal union catches
   * typos at compile time.
   */
  readonly expectedFailures?: ReadonlyArray<MigrationContractAssertion>;
}
