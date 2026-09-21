/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-export shim; see the sibling note in
 * `storage-tabular/genericTabularStorageTests.ts`. The suite moved to
 * `@workglow/test-contract/job-queue` so a queue backend written outside this
 * repository inherits it; the concrete callers stay here.
 */
export * from "@workglow/test-contract/job-queue";
