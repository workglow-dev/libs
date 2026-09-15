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

export function idempotentRunBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("idempotentRun") ? itExpectFail : it;

  describe("Idempotent run", () => {
    itImpl(
      "second run with the same migration set applies nothing and re-invokes no up()",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const component = `contract-idempotent-${Date.now()}`;

        // Build a fresh batch for each run so the assertion exercises the
        // bookkeeping lookup, not migration-object identity. A runner that
        // (incorrectly) cached "already applied" by object identity would
        // pass with reused references but fail here.
        const firstBatch = [
          handle.buildMigration(component, 1, recorder),
          handle.buildMigration(component, 2, recorder),
        ];
        const firstApplied = await runner.run(firstBatch);
        expect(firstApplied.length, "first run applies all pending migrations").toBe(2);
        expect(recorder.calls.length, "first run invokes up() for each pending migration").toBe(2);

        recorder.clear();
        const secondBatch = [
          handle.buildMigration(component, 1, recorder),
          handle.buildMigration(component, 2, recorder),
        ];
        const secondApplied = await runner.run(secondBatch);
        expect(secondApplied.length, "second run skips already-applied migrations").toBe(0);
        expect(recorder.calls.length, "second run invokes no up() callbacks").toBe(0);

        // Bookkeeping table still reports both versions.
        const recordedVersions = await runner.appliedVersions(component);
        expect(
          [...recordedVersions].sort((a, b) => a - b),
          "appliedVersions persists across the no-op rerun"
        ).toEqual([1, 2]);
      },
      opts.timeout
    );
  });
}
