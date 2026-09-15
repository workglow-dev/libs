/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import {
  createMigrationCallRecorder,
  type MigrationContractHandle,
  type MigrationRunnerContractOpts,
} from "../types";

export function failedMigrationNotRecordedBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("failedMigrationNotRecorded") ? itExpectFail : it;

  describe("Failed migration not recorded", () => {
    itImpl(
      "when up() throws, the failed migration's version is not recorded and a re-run with a healthy version applies it",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const component = `contract-failure-${Date.now()}`;

        // First migration succeeds; second migration is configured to throw.
        const v1 = handle.buildMigration(component, 1, recorder);
        const v2Failing = handle.buildMigration(component, 2, recorder, { fail: true });

        await expect(runner.run([v1, v2Failing])).rejects.toThrow();

        // The failed version MUST NOT be recorded (otherwise retry is
        // impossible). Whether v1 is recorded depends on per-migration
        // versus per-batch atomicity — Postgres commits each migration
        // independently, while IndexedDB rolls back the entire upgrade
        // transaction. Both behaviors are spec-compliant; the contract
        // only requires that the failed version stays absent.
        const afterFailure = await runner.appliedVersions(component);
        expect(afterFailure.has(2), "failed migration is not recorded as applied").toBe(false);

        // Re-running with a non-failing v2 must converge to the full
        // applied set [1, 2] regardless of which atomicity style the
        // adapter uses.
        recorder.clear();
        const v2Recovered = handle.buildMigration(component, 2, recorder);
        const applied = await runner.run([v1, v2Recovered]);
        expect(
          applied.length,
          "recovery run applies at least one migration"
        ).toBeGreaterThanOrEqual(1);
        expect(
          applied.some((m) => m.version === 2),
          "recovery run applies v2"
        ).toBe(true);

        // Recorder converges with `applied` regardless of atomicity style:
        //   - Per-migration-atomic (Postgres / SQLite) — v1 was already
        //     committed, only v2 re-runs: applied = [v2], recorder = [v2].
        //   - Per-batch-atomic (IndexedDB rolls back the whole upgrade)
        //     — both re-run: applied = [v1, v2], recorder = [v1, v2].
        // Either way, every entry the runner reports as applied this call
        // corresponds to exactly one `up()` invocation. A future regression
        // that double-invokes `up()` would break the strict-equality check.
        expect(
          recorder.calls.length,
          "recovery run invokes up() at least once"
        ).toBeGreaterThanOrEqual(1);
        expect(
          recorder.calls.some((c) => c.component === component && c.version === 2),
          "recovery run invokes up() for v2"
        ).toBe(true);
        expect(
          recorder.calls.length,
          "recovery up() invocations match `applied` exactly (no double-invocation)"
        ).toBe(applied.length);

        const finalVersions = await runner.appliedVersions(component);
        expect(
          [...finalVersions].sort((a, b) => a - b),
          "after recovery the bookkeeping table reports the full set"
        ).toEqual([1, 2]);
      },
      opts.timeout
    );
  });
}
