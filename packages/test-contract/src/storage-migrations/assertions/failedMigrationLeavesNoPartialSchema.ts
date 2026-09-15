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
 * A migration whose `up()` creates a probe schema element and then throws
 * must leave no trace of the probe after the runner rejects. Backends
 * without atomic DDL (e.g. SQLite without an explicit transaction wrapper)
 * retain the partial schema and should mark this assertion as
 * `expectedFailures: ["failedMigrationLeavesNoPartialSchema"]`.
 */
export function failedMigrationLeavesNoPartialSchemaBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("failedMigrationLeavesNoPartialSchema") ? itExpectFail : it;

  describe("Failed migration leaves no partial schema", () => {
    itImpl(
      "probe schema is rolled back after up() throws",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const component = `contract-partial-schema-${Date.now()}`;
        const probeName = `_probe_${Math.random().toString(36).slice(2, 10)}`;
        const migration = handle.buildMigration(component, 1, recorder, { probeName });

        await expect(runner.run([migration])).rejects.toBeDefined();

        const exists = await handle.probeExists(probeName);
        expect(exists, "probe schema element does not persist after up() throws").toBe(false);
      },
      opts.timeout
    );
  });
}
