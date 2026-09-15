/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `ITabularStorage` — the behaviour every backend owes a
 * caller, including the two join strategies and the guards that bound them.
 */

export * from "./tabular-storage/assertions/countMatchesQuery";
export * from "./tabular-storage/assertions/guardParity";
export * from "./tabular-storage/assertions/inListCriterion";
export * from "./tabular-storage/assertions/joinBoundedLeftRead";
export * from "./tabular-storage/assertions/joinPushdown";
export * from "./tabular-storage/assertions/notInListCriterion";
export * from "./tabular-storage/assertions/strategyParity";
export * from "./tabular-storage/assertions/subscribeToChanges";
export * from "./tabular-storage/assertions/vectorColumnFormat";
export * from "./tabular-storage/assertions/withConnectionTransaction";
export * from "./tabular-storage/assertions/withTransactionRollback";
export * from "./tabular-storage/fixtures";
export * from "./tabular-storage/joinFixtures";
export * from "./tabular-storage/runTabularJoinContract";
export * from "./tabular-storage/runTabularStorageContract";
export * from "./tabular-storage/types";
