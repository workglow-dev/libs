/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe } from "vitest";
import { countMatchesQueryBlock } from "./assertions/countMatchesQuery";
import { guardParityBlock } from "./assertions/guardParity";
import { inListCriterionBlock } from "./assertions/inListCriterion";
import { joinPushdownBlock } from "./assertions/joinPushdown";
import { notInListCriterionBlock } from "./assertions/notInListCriterion";
import { subscribeToChangesBlock } from "./assertions/subscribeToChanges";
import { vectorColumnFormatBlock } from "./assertions/vectorColumnFormat";
import { withConnectionTransactionBlock } from "./assertions/withConnectionTransaction";
import { withTransactionRollbackBlock } from "./assertions/withTransactionRollback";
import type { TabularStorageContractOpts } from "./types";

export function runTabularStorageContract(opts: TabularStorageContractOpts): void {
  describe.skipIf(opts.skip)(`Tabular storage contract: ${opts.name}`, () => {
    subscribeToChangesBlock(opts);
    vectorColumnFormatBlock(opts);
    withTransactionRollbackBlock(opts);
    withConnectionTransactionBlock(opts);
    countMatchesQueryBlock(opts);
    inListCriterionBlock(opts);
    notInListCriterionBlock(opts);
    joinPushdownBlock(opts);
    guardParityBlock(opts);
  });
}

export { VectorItemPrimaryKeyNames, VectorItemSchema } from "./types";
export type { TabularStorageContractAssertion, TabularStorageContractOpts } from "./types";
