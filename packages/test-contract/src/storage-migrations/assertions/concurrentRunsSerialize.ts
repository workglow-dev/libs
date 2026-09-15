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

/**
 * Concurrent `run()` calls against the same backing database — possibly
 * across different runner instances — must execute each migration's `up()`
 * exactly once and converge appliedVersions on a single row per
 * `(component, version)`.
 *
 * Adapters that rely solely on the bookkeeping PK to resolve races (race
 * losers see 23505 and treat as success) will run `up()` multiple times
 * before that resolution, and should mark this assertion as
 * `expectedFailures: ["concurrentRunsSerialize"]`.
 */
export function concurrentRunsSerializeBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("concurrentRunsSerialize") ? itExpectFail : it;

  describe("Concurrent runs serialize", () => {
    itImpl(
      "three racing runners against the same database execute up() exactly once",
      async () => {
        const handle = getHandle();
        const recorder = createMigrationCallRecorder();
        const component = `contract-serialize-${Date.now()}`;
        const migration = handle.buildMigration(component, 1, recorder);

        const r1 = await handle.createRunner();
        const r2 = await handle.createRunner();
        const r3 = await handle.createRunner();
        // allSettled — when serialization is broken, racing callers can
        // raise (e.g. PK violation on bookkeeping insert). The contract
        // violation we care about is observable via the recorder and
        // appliedVersions, not via which call rejected.
        await Promise.allSettled([r1.run([migration]), r2.run([migration]), r3.run([migration])]);

        expect(
          recorder.calls.filter((c) => c.component === component),
          "exactly one of the three racing runners executed up()"
        ).toHaveLength(1);
        const versions = await (await handle.createRunner()).appliedVersions(component);
        expect(
          [...versions].sort((a, b) => a - b),
          "appliedVersions converges on a single (component, version) row"
        ).toEqual([1]);
      },
      opts.timeout
    );
  });
}
