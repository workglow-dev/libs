/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchemaObject } from "@workglow/util/schema";

/**
 * The row shape every tabular assertion in this contract reads and writes.
 *
 * A compound primary key (`name` + `type`) rather than a single column, because
 * a backend that gets one key right and the pair wrong is the common failure —
 * cursor encoding, `getBulk` chunking and the join's tuple fingerprint all
 * behave differently once the key has two parts.
 */
export const CompoundPrimaryKeyNames = ["name", "type"] as const;
export const CompoundSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    option: { type: "string" },
    success: { type: "boolean" },
  },
  required: ["name", "type", "option", "success"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;
