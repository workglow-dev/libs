/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe } from "vitest";

import { addAndDropIndexBlock } from "./assertions/addAndDropIndex";
import { addColumnBlock } from "./assertions/addColumn";
import { backfillBlock } from "./assertions/backfill";
import { dropColumnBlock } from "./assertions/dropColumn";
import { failedMigrationNotRecordedBlock } from "./assertions/failedMigrationNotRecorded";
import { freshDbFastPathBlock } from "./assertions/freshDbFastPath";
import { incrementalApplicationBlock } from "./assertions/incrementalApplication";
import { renameColumnBlock } from "./assertions/renameColumn";
import type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "./types";

export function runTabularMigrationContract(opts: TabularMigrationContractOpts): void {
  describe.skipIf(opts.skip)(`Tabular migration contract: ${opts.name}`, () => {
    let handle: TabularMigrationContractHandle | undefined;
    const getHandle = (): TabularMigrationContractHandle => {
      if (!handle) throw new Error("handle not initialized");
      return handle;
    };

    beforeAll(async () => {
      handle = await opts.factory();
    }, opts.timeout);
    afterAll(async () => {
      if (handle) await handle.dispose();
    });

    if (opts.enforcesDdl) {
      addColumnBlock(opts, getHandle);
      dropColumnBlock(opts, getHandle);
      renameColumnBlock(opts, getHandle);
      addAndDropIndexBlock(opts, getHandle);
    }
    backfillBlock(opts, getHandle);
    freshDbFastPathBlock(opts, getHandle);
    if (opts.persistentBookkeeping !== false) {
      incrementalApplicationBlock(opts, getHandle);
      failedMigrationNotRecordedBlock(opts, getHandle);
    }
  });
}

export type { TabularMigrationContractHandle, TabularMigrationContractOpts } from "./types";
