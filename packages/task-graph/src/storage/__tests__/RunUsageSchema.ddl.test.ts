/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getNonNullSchema, mapPostgresType } from "@workglow/storage";
import type { JsonSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";
import { USAGE_COUNTER_FIELDS } from "../../task/StreamTypes";
import { RunUsageSchema } from "../RunUsageSchema";

/**
 * Every token counter on {@link RunUsageSchema} is declared nullable in the
 * `type: ["integer", "null"]` array spelling, which `getNonNullSchema` collapses
 * to `{type: "integer"}` before `mapPostgresType` reads it.
 *
 * This pins the resulting DDL because the mapping is what makes these columns
 * `INTEGER` rather than `TEXT /* unknown type *\/`, and `CREATE TABLE IF NOT
 * EXISTS` never alters an existing table — so a change here silently splits
 * fresh databases from pre-existing ones (a counter read back as `string`
 * instead of `number`) with nothing else failing. If this test moves, the
 * README's "Nullable columns and generated DDL" operator note moves with it.
 *
 * Driven off the canonical counter list rather than a copy of it, so a counter
 * added to `Usage` without a matching column fails here instead of being
 * dropped on the way to storage.
 */
const COUNTER_COLUMNS = USAGE_COUNTER_FIELDS;

describe("RunUsageSchema generated DDL", () => {
  const ddl = (schema: JsonSchema): string =>
    mapPostgresType(schema, { getNonNullType: getNonNullSchema });

  it.each(COUNTER_COLUMNS)("every RunUsage counter maps to an INTEGER column (%s)", (column) => {
    const typeDef = (RunUsageSchema.properties as Record<string, JsonSchema>)[column];
    expect(typeDef).toBeDefined();
    expect(ddl(typeDef)).toBe("INTEGER");
  });

  it("declares each counter in the nullable type-array spelling", () => {
    for (const column of COUNTER_COLUMNS) {
      const typeDef = (RunUsageSchema.properties as Record<string, { type?: unknown }>)[column];
      expect(typeDef.type).toEqual(["integer", "null"]);
    }
  });
});
