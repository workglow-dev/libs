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

export function ensureBookkeepingIdempotentBlock<DB>(
  opts: MigrationRunnerContractOpts<DB>,
  getHandle: () => MigrationContractHandle<DB>
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("ensureBookkeepingIdempotent") ? itExpectFail : it;

  describe("Ensure bookkeeping idempotent", () => {
    itImpl(
      "calling ensureBookkeepingTable twice does not throw",
      async () => {
        const runner = await getHandle().createRunner();
        await runner.ensureBookkeepingTable();
        await expect(runner.ensureBookkeepingTable()).resolves.toBeUndefined();
      },
      opts.timeout
    );

    itImpl(
      "appliedVersions on a never-touched component returns an empty set",
      async () => {
        const runner = await getHandle().createRunner();
        await runner.ensureBookkeepingTable();
        const seen = await runner.appliedVersions(`never-touched-${Date.now()}`);
        expect(seen.size, "untouched component has no applied versions").toBe(0);
      },
      opts.timeout
    );

    itImpl(
      "ensureBookkeepingTable does not contaminate sibling components",
      async () => {
        const handle = getHandle();
        const runner = await handle.createRunner();
        const recorder = createMigrationCallRecorder();
        const suffix = Date.now();
        const owner = `contract-bookkeeping-owner-${suffix}`;
        const sibling = `contract-bookkeeping-sibling-${suffix}`;

        // Seed `owner` with one applied migration.
        await runner.run([handle.buildMigration(owner, 1, recorder)]);

        // Re-running ensureBookkeepingTable on an already-initialised store
        // must not drop, duplicate, or leak rows across components.
        await runner.ensureBookkeepingTable();
        await runner.ensureBookkeepingTable();

        const ownerVersions = await runner.appliedVersions(owner);
        expect(
          [...ownerVersions].sort((a, b) => a - b),
          "ensureBookkeepingTable preserves prior applied versions for the seeded component"
        ).toEqual([1]);

        const siblingVersions = await runner.appliedVersions(sibling);
        expect(
          siblingVersions.size,
          "ensureBookkeepingTable does not leak rows into a sibling component"
        ).toBe(0);
      },
      opts.timeout
    );
  });
}
