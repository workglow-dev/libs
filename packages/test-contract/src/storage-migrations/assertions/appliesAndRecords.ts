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

export function appliesAndRecordsBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("appliesAndRecords") ? itExpectFail : it;

  describe("Applies and records", () => {
    itImpl(
      "first run applies all migrations in (component, version) order and records each version",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const component = `contract-applies-${Date.now()}`;
        const migrations = [
          handle.buildMigration(component, 2, recorder),
          handle.buildMigration(component, 1, recorder),
          handle.buildMigration(component, 3, recorder),
        ];

        const applied = await runner.run(migrations);

        expect(applied.length, "all three migrations are reported as applied").toBe(3);
        expect(
          applied.map((m) => m.version),
          "applied[] is returned in (component, version) order"
        ).toEqual([1, 2, 3]);
        expect(
          recorder.calls.map((c) => c.version),
          "up() is invoked in (component, version) order"
        ).toEqual([1, 2, 3]);
        const recordedVersions = await runner.appliedVersions(component);
        expect(
          [...recordedVersions].sort((a, b) => a - b),
          "every applied version is recorded in the bookkeeping table"
        ).toEqual([1, 2, 3]);
      },
      opts.timeout
    );

    itImpl(
      "interleaved multi-component input is applied in (component, version) order",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const suffix = Date.now();
        const a = `contract-applies-a-${suffix}`;
        const b = `contract-applies-b-${suffix}`;

        // Interleaved input across two components in not-already-sorted
        // order. `sortMigrations` is documented to stably sort by
        // (component asc, version asc), and every concrete runner calls
        // it before iterating; this assertion locks that invariant in.
        const applied = await runner.run([
          handle.buildMigration(b, 2, recorder),
          handle.buildMigration(a, 1, recorder),
          handle.buildMigration(b, 1, recorder),
          handle.buildMigration(a, 2, recorder),
        ]);

        const expected = [
          [a, 1],
          [a, 2],
          [b, 1],
          [b, 2],
        ];
        expect(
          applied.map((m) => [m.component, m.version]),
          "interleaved multi-component input is sorted (component asc, version asc) before applying"
        ).toEqual(expected);
        // Recorder agrees with the runner loop order, not just `applied` —
        // catches a runner that returns the right `applied` array but
        // invokes `up()` in input order.
        expect(
          recorder.calls.map((c) => [c.component, c.version]),
          "up() invocation order matches sorted (component, version)"
        ).toEqual(expected);

        const aVersions = await runner.appliedVersions(a);
        const bVersions = await runner.appliedVersions(b);
        expect(
          [...aVersions].sort((x, y) => x - y),
          "appliedVersions(a) reports both versions"
        ).toEqual([1, 2]);
        expect(
          [...bVersions].sort((x, y) => x - y),
          "appliedVersions(b) reports both versions"
        ).toEqual([1, 2]);
      },
      opts.timeout
    );
  });
}
