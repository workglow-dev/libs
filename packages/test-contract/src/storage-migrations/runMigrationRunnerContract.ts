/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe } from "vitest";

import { appliesAndRecordsBlock } from "./assertions/appliesAndRecords";
import { concurrentRunsSerializeBlock } from "./assertions/concurrentRunsSerialize";
import { ensureBookkeepingIdempotentBlock } from "./assertions/ensureBookkeepingIdempotent";
import { failedMigrationLeavesNoPartialSchemaBlock } from "./assertions/failedMigrationLeavesNoPartialSchema";
import { failedMigrationNotRecordedBlock } from "./assertions/failedMigrationNotRecorded";
import { idempotentRunBlock } from "./assertions/idempotentRun";
import { incrementalApplicationBlock } from "./assertions/incrementalApplication";
import type { MigrationContractHandle, MigrationRunnerContractOpts } from "./types";

export function runMigrationRunnerContract<DB>(opts: MigrationRunnerContractOpts<DB>): void {
  describe.skipIf(opts.skip)(`Migration runner contract: ${opts.name}`, () => {
    let handle: MigrationContractHandle<DB> | undefined;
    const getHandle = (): MigrationContractHandle<DB> => {
      if (!handle) throw new Error("migration contract handle not initialized");
      return handle;
    };

    beforeAll(async () => {
      handle = await opts.factory();
    }, opts.timeout);

    afterAll(async () => {
      if (handle) await handle.dispose();
    });

    ensureBookkeepingIdempotentBlock(opts, getHandle);
    appliesAndRecordsBlock(opts, getHandle);
    idempotentRunBlock(opts, getHandle);
    incrementalApplicationBlock(opts, getHandle);
    failedMigrationNotRecordedBlock(opts, getHandle);
    concurrentRunsSerializeBlock(opts, getHandle);
    failedMigrationLeavesNoPartialSchemaBlock(opts, getHandle);
  });
}

export { createMigrationCallRecorder } from "./types";
export type {
  BuildMigrationFn,
  BuildMigrationOptions,
  MigrationCallRecorder,
  MigrationContractAssertion,
  MigrationContractHandle,
  MigrationRunnerContractOpts,
} from "./types";
