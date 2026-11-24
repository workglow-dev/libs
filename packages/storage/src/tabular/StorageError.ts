/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseError } from "@workglow/util";

export class StorageError extends BaseError {
  static override readonly type: string = "StorageError";
}

export class StorageValidationError extends StorageError {
  static override readonly type: string = "StorageValidationError";
}

export class StorageEmptyCriteriaError extends StorageValidationError {
  static override readonly type: string = "StorageEmptyCriteriaError";
  constructor() {
    super("Query criteria must not be empty. Use getAll() to retrieve all records.");
  }
}

export class StorageInvalidLimitError extends StorageValidationError {
  static override readonly type: string = "StorageInvalidLimitError";
  constructor(limit: number) {
    // Message names both constraints (positive AND integer) so callers
    // hitting the error from `runPage` (which rejects non-integer limits)
    // see the same wording as offset paths — and a user staring at
    // `limit: 1.5` isn't left guessing that fractional values are the
    // problem.
    super(`Query limit must be a positive integer, got ${limit}`);
  }
}

export class StorageInvalidColumnError extends StorageValidationError {
  static override readonly type: string = "StorageInvalidColumnError";
  constructor(column: string) {
    super(`Column "${column}" does not exist in the schema`);
  }
}

/**
 * A `deleteSearch` whose criteria name no rows in particular — every criterion
 * matches every row, so the statement reduces to `DELETE FROM t`.
 *
 * Today that means criteria consisting only of empty `not-in` lists: excluding
 * nothing is a faithful match-all, and the right answer for `query` and
 * `count`, but on a delete it is indistinguishable from a filter that went
 * missing. Exclusion lists are usually built from caller input, so the case
 * that reads as a bug is the one that empties the table. `deleteAll()` says it
 * on purpose.
 */
export class StorageUnfilteredDeleteError extends StorageValidationError {
  static override readonly type: string = "StorageUnfilteredDeleteError";
  constructor(columns: readonly string[]) {
    super(
      `deleteSearch criteria match every row (${columns
        .map((c) => `"${c}"`)
        .join(", ")} exclude nothing), which would delete the whole table. ` +
        `Use deleteAll() if that is the intent.`
    );
  }
}

export class StorageUnsupportedError extends StorageError {
  static override readonly type: string = "StorageUnsupportedError";
  constructor(operation: string, backend: string) {
    super(`${operation} is not supported for ${backend}`);
  }
}

/**
 * A stored record exists but cannot be decoded (a truncated or hand-edited
 * file, say). Raised rather than treating the record as absent: a listing that
 * quietly drops it disagrees with `size()`, and a caller reading "missing"
 * would overwrite or re-create what is in fact damaged data.
 */
export class StorageCorruptionError extends StorageError {
  static override readonly type: string = "StorageCorruptionError";
  constructor(
    public readonly location: string,
    options?: { cause?: unknown }
  ) {
    super(`Stored record at "${location}" is corrupt and cannot be read`, options);
  }
}
