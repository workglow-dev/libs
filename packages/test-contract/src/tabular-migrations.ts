/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for tabular schema migrations — add, drop, rename and
 * backfill against a live table.
 */

export * from "./tabular-migrations/runTabularMigrationContract";
export * from "./tabular-migrations/types";
export * from "./tabular-migrations/assertions/addAndDropIndex";
export * from "./tabular-migrations/assertions/addColumn";
export * from "./tabular-migrations/assertions/backfill";
export * from "./tabular-migrations/assertions/dropColumn";
export * from "./tabular-migrations/assertions/failedMigrationNotRecorded";
export * from "./tabular-migrations/assertions/freshDbFastPath";
export * from "./tabular-migrations/assertions/incrementalApplication";
export * from "./tabular-migrations/assertions/renameColumn";
