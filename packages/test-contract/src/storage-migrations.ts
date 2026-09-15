/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IMigrationRunner` — what a migration records, what a
 * failed one leaves behind, and what a second run does.
 */

export * from "./storage-migrations/runMigrationRunnerContract";
export * from "./storage-migrations/types";
export * from "./storage-migrations/assertions/appliesAndRecords";
export * from "./storage-migrations/assertions/concurrentRunsSerialize";
export * from "./storage-migrations/assertions/ensureBookkeepingIdempotent";
export * from "./storage-migrations/assertions/failedMigrationLeavesNoPartialSchema";
export * from "./storage-migrations/assertions/failedMigrationNotRecorded";
export * from "./storage-migrations/assertions/idempotentRun";
export * from "./storage-migrations/assertions/incrementalApplication";
