/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ALLOWED_SEARCH_OPERATORS,
  buildSearchWhere,
  DuckDbDialect,
  isSearchCondition,
  isSearchInCondition,
  isSearchLikeCondition,
  isSearchNotInCondition,
  normalizeCriterion,
  PostgresDialect,
  SEARCH_OPERATOR_SET,
  SqliteDialect,
} from "@workglow/storage";
import type {
  SearchCondition,
  SearchInCondition,
  SearchNotInCondition,
  ValueOptionType,
} from "@workglow/storage";
import { describe, expect, it } from "vitest";

interface Row {
  readonly id: string;
  readonly value: number;
  readonly createdAt: string;
}

const schemaProps: Record<string, unknown> = {
  id: { type: "string" },
  value: { type: "number" },
  createdAt: { type: "string" },
};

const passthroughConvert = (_column: string, value: Row[keyof Row]): ValueOptionType =>
  value as ValueOptionType;

describe("PredicateBuilder operator allow-list (L-MAIN-01)", () => {
  describe("ALLOWED_SEARCH_OPERATORS / SEARCH_OPERATOR_SET", () => {
    it("contains exactly the six SQL comparison operators", () => {
      expect([...ALLOWED_SEARCH_OPERATORS].sort()).toEqual(["!=", "<", "<=", "=", ">", ">="]);
    });

    it("SEARCH_OPERATOR_SET mirrors ALLOWED_SEARCH_OPERATORS", () => {
      for (const op of ALLOWED_SEARCH_OPERATORS) {
        expect(SEARCH_OPERATOR_SET.has(op)).toBe(true);
      }
      expect(SEARCH_OPERATOR_SET.size).toBe(ALLOWED_SEARCH_OPERATORS.length);
    });
  });

  describe("isSearchCondition", () => {
    it("accepts every allowed operator", () => {
      for (const operator of ALLOWED_SEARCH_OPERATORS) {
        const candidate = { value: 1, operator };
        expect(isSearchCondition(candidate)).toBe(true);
      }
    });

    it("rejects a forged operator (e.g. SQL injection attempt)", () => {
      const forged = { value: 1, operator: "OR 1=1 --" };
      expect(isSearchCondition(forged)).toBe(false);
    });

    it("rejects a LIKE operator that is not in the allow-list", () => {
      const forged = { value: "x", operator: "LIKE" };
      expect(isSearchCondition(forged)).toBe(false);
    });

    it("rejects non-object values", () => {
      expect(isSearchCondition(null)).toBe(false);
      expect(isSearchCondition("=")).toBe(false);
      expect(isSearchCondition(42)).toBe(false);
    });

    it("rejects objects missing value or operator", () => {
      expect(isSearchCondition({ value: 1 })).toBe(false);
      expect(isSearchCondition({ operator: "=" })).toBe(false);
    });
  });

  describe("buildSearchWhere", () => {
    it("round-trips equality with SQLite placeholders", () => {
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`id` = ?");
      expect(result.params).toEqual(["abc"]);
    });

    it("round-trips a non-equality SearchCondition with Postgres placeholders", () => {
      const criterion: SearchCondition<number> = { value: 100, operator: "<" };
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { value: criterion },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe('"value" < $1');
      expect(result.params).toEqual([100]);
    });

    it("AND-joins multiple columns and increments the parameter index", () => {
      const criterion: SearchCondition<string> = {
        value: "2025-01-01T00:00:00Z",
        operator: "<=",
      };
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { id: "abc", createdAt: criterion },
        schemaProps,
        passthroughConvert,
        5
      );
      // First column "id" → $5 (=), second column "createdAt" → $6 (<=)
      expect(result.whereClause).toBe('"id" = $5 AND "createdAt" <= $6');
      expect(result.params).toEqual(["abc", "2025-01-01T00:00:00Z"]);
    });

    it("treats a forged operator as a literal value (no SQL injection)", () => {
      // Simulate JSON arriving from an HTTP boundary that smuggles an
      // unsafe operator past the type system (e.g. `as unknown as`).
      // `isSearchCondition` rejects the forged criterion, so it is treated
      // as a literal equality value rather than a SearchCondition. The raw
      // SQL injection attempt becomes the parameter for `=`, not part of
      // the operator slot — which is what we want.
      const forged = { value: 1, operator: "OR 1=1 --" } as unknown as SearchCondition<number>;
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { value: forged },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`value` = ?");
      // The whole forged object is the bound value — no SQL injection.
      expect(result.params).toEqual([forged]);
    });

    it("binds an `undefined` criterion as a parameter rather than rewriting it", () => {
      // The `= NULL` → `IS NULL` rewrite above is deliberately NOT extended to
      // `undefined`: a key present with no value is indistinguishable from a
      // filter the caller meant to omit, and guessing would trade a visible
      // bug for an invisible one. So it stays an ordinary equality — which the
      // driver binds as NULL, making `col = NULL` match no row.
      //
      // The driver binds it as NULL, so this matches no row — and the JS-side
      // matchers now answer the same, so the criterion means one thing on
      // every backend.
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { id: undefined } as never,
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`id` = ?");
      expect(result.params).toHaveLength(1);
      expect(result.params[0]).toBeUndefined();
    });

    it("throws when the column is not present in the schema", () => {
      expect(() =>
        buildSearchWhere<Row>(
          SqliteDialect,
          { unknownColumn: "x" } as never,
          schemaProps,
          passthroughConvert
        )
      ).toThrow(/Schema must have a "unknownColumn" field/);
    });
  });

  describe("in-list criteria", () => {
    const inCriterion = (values: number[]): SearchInCondition<number> => ({
      value: values,
      operator: "in",
    });

    it("expands one placeholder per value on SQLite", () => {
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { value: inCriterion([1, 2, 3]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`value` IN (?, ?, ?)");
      expect(result.params).toEqual([1, 2, 3]);
    });

    it("binds the whole list as ONE array parameter on Postgres", () => {
      // This is the difference that makes an in-list unbounded on Postgres and
      // capped by SQLITE_MAX_VARIABLE_NUMBER on SQLite. If this ever regresses
      // to expanded placeholders, a long list starts failing at 65535 params.
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { value: inCriterion([1, 2, 3]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe('"value" = ANY($1)');
      expect(result.params).toEqual([[1, 2, 3]]);
    });

    it("expands with $N numbering on DuckDB, whose driver has no array binding", () => {
      const result = buildSearchWhere<Row>(
        DuckDbDialect,
        { value: inCriterion([1, 2]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe('"value" IN ($1, $2)');
      expect(result.params).toEqual([1, 2]);
    });

    it("advances the placeholder index past every value it bound", () => {
      // Postgres consumes ONE index for the array, so a following column must
      // land on $2 — deriving the next index from the value count would skew it.
      const pg = buildSearchWhere<Row>(
        PostgresDialect,
        { value: inCriterion([1, 2, 3]), id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(pg.whereClause).toBe('"value" = ANY($1) AND "id" = $2');
      expect(pg.params).toEqual([[1, 2, 3], "abc"]);

      // DuckDB consumes three, so the following column lands on $4.
      const duck = buildSearchWhere<Row>(
        DuckDbDialect,
        { value: inCriterion([1, 2, 3]), id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(duck.whereClause).toBe('"value" IN ($1, $2, $3) AND "id" = $4');
      expect(duck.params).toEqual([1, 2, 3, "abc"]);
    });

    it("emits an always-false predicate for an empty list, binding nothing", () => {
      // `IN ()` is a syntax error in every dialect here.
      for (const dialect of [SqliteDialect, PostgresDialect, DuckDbDialect]) {
        const result = buildSearchWhere<Row>(
          dialect,
          { value: inCriterion([]) },
          schemaProps,
          passthroughConvert
        );
        expect(result.whereClause).toBe("1 = 0");
        expect(result.params).toEqual([]);
      }
    });

    it("runs each element through convertValue, like a scalar value", () => {
      const upper = (_column: string, value: Row[keyof Row]): ValueOptionType =>
        String(value).toUpperCase();
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { id: { value: ["a", "b"], operator: "in" } as SearchInCondition<string> },
        schemaProps,
        upper
      );
      expect(result.params).toEqual(["A", "B"]);
    });
  });

  describe("isSearchInCondition", () => {
    it("accepts an in-condition with an array value", () => {
      expect(isSearchInCondition({ value: [1, 2], operator: "in" })).toBe(true);
      expect(isSearchInCondition({ value: [], operator: "in" })).toBe(true);
    });

    it("rejects an in-condition whose value is not an array", () => {
      // The JSON trust boundary: a forged `in` must not reach a builder that
      // assumes it can map over the value.
      expect(isSearchInCondition({ value: "1,2", operator: "in" })).toBe(false);
      expect(isSearchInCondition({ value: 1, operator: "in" })).toBe(false);
    });

    it("does not accept the scalar operators, and `in` is not in the scalar allow-list", () => {
      expect(isSearchInCondition({ value: 1, operator: "=" })).toBe(false);
      // `in` must never reach the code path that interpolates an operator
      // straight into SQL.
      expect(SEARCH_OPERATOR_SET.has("in" as never)).toBe(false);
      expect(isSearchCondition({ value: [1], operator: "in" })).toBe(false);
    });
  });

  describe("not-in-list criteria", () => {
    const notInCriterion = (values: number[]): SearchNotInCondition<number> => ({
      value: values,
      operator: "not-in",
    });

    it("expands one placeholder per value on SQLite", () => {
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { value: notInCriterion([1, 2, 3]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`value` NOT IN (?, ?, ?)");
      expect(result.params).toEqual([1, 2, 3]);
    });

    it("binds the whole list as ONE array parameter on Postgres, via <> ALL", () => {
      // The mirror of `= ANY($n)`, and for the same reason: an exclusion list
      // of any length costs one placeholder, so it is not capped at 65535.
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { value: notInCriterion([1, 2, 3]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe('"value" <> ALL($1)');
      expect(result.params).toEqual([[1, 2, 3]]);
    });

    it("expands with $N numbering on DuckDB, whose driver has no array binding", () => {
      const result = buildSearchWhere<Row>(
        DuckDbDialect,
        { value: notInCriterion([1, 2]) },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe('"value" NOT IN ($1, $2)');
      expect(result.params).toEqual([1, 2]);
    });

    it("advances the placeholder index past every value it bound", () => {
      const pg = buildSearchWhere<Row>(
        PostgresDialect,
        { value: notInCriterion([1, 2, 3]), id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(pg.whereClause).toBe('"value" <> ALL($1) AND "id" = $2');
      expect(pg.params).toEqual([[1, 2, 3], "abc"]);

      const duck = buildSearchWhere<Row>(
        DuckDbDialect,
        { value: notInCriterion([1, 2, 3]), id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(duck.whereClause).toBe('"value" NOT IN ($1, $2, $3) AND "id" = $4');
      expect(duck.params).toEqual([1, 2, 3, "abc"]);
    });

    it("emits an always-TRUE predicate for an empty list, binding nothing", () => {
      // The complement of the empty `in` list: excluding nothing excludes
      // nothing. `1 = 0` here would silently invert the caller's filter.
      for (const dialect of [SqliteDialect, PostgresDialect, DuckDbDialect]) {
        const result = buildSearchWhere<Row>(
          dialect,
          { value: notInCriterion([]) },
          schemaProps,
          passthroughConvert
        );
        expect(result.whereClause).toBe("1 = 1");
        expect(result.params).toEqual([]);
      }
    });

    it("does not advance the placeholder index for an empty list", () => {
      const pg = buildSearchWhere<Row>(
        PostgresDialect,
        { value: notInCriterion([]), id: "abc" },
        schemaProps,
        passthroughConvert
      );
      expect(pg.whereClause).toBe('1 = 1 AND "id" = $1');
      expect(pg.params).toEqual(["abc"]);
    });

    it("runs each element through convertValue, like a scalar value", () => {
      const upper = (_column: string, value: Row[keyof Row]): ValueOptionType =>
        String(value).toUpperCase();
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { id: { value: ["a", "b"], operator: "not-in" } as SearchNotInCondition<string> },
        schemaProps,
        upper
      );
      expect(result.params).toEqual(["A", "B"]);
    });
  });

  describe("isSearchNotInCondition", () => {
    it("accepts a not-in condition with an array value", () => {
      expect(isSearchNotInCondition({ value: [1, 2], operator: "not-in" })).toBe(true);
      expect(isSearchNotInCondition({ value: [], operator: "not-in" })).toBe(true);
    });

    it("rejects a not-in condition whose value is not an array", () => {
      expect(isSearchNotInCondition({ value: "1,2", operator: "not-in" })).toBe(false);
      expect(isSearchNotInCondition({ value: 1, operator: "not-in" })).toBe(false);
    });

    it("keeps `not-in` out of the scalar allow-list and the other two guards", () => {
      // The same closed-allow-list rule `in` is held to: `not-in` must never
      // reach the code path that interpolates an operator straight into SQL.
      expect(SEARCH_OPERATOR_SET.has("not-in" as never)).toBe(false);
      expect(isSearchCondition({ value: [1], operator: "not-in" })).toBe(false);
      expect(isSearchInCondition({ value: [1], operator: "not-in" })).toBe(false);
      expect(isSearchNotInCondition({ value: [1], operator: "in" })).toBe(false);
    });

    it("rejects a forged operator that only looks like it", () => {
      expect(isSearchNotInCondition({ value: [1], operator: "not in" })).toBe(false);
      expect(isSearchNotInCondition({ value: [1], operator: "NOT IN" })).toBe(false);
      expect(isSearchNotInCondition({ value: [1], operator: "not-in) OR 1=1 --" })).toBe(false);
    });
  });

  describe("normalizeCriterion", () => {
    it("resolves all four criterion shapes", () => {
      expect(normalizeCriterion(5)).toEqual({ kind: "compare", operator: "=", value: 5 });
      expect(normalizeCriterion({ value: 5, operator: "<" })).toEqual({
        kind: "compare",
        operator: "<",
        value: 5,
      });
      expect(normalizeCriterion({ value: [5, 6], operator: "in" })).toEqual({
        kind: "in",
        values: [5, 6],
      });
      expect(normalizeCriterion({ value: [5, 6], operator: "not-in" })).toEqual({
        kind: "not-in",
        values: [5, 6],
      });
    });

    it("treats a forged criterion as a literal value rather than an operator", () => {
      const forged = { value: 1, operator: "OR 1=1 --" };
      expect(normalizeCriterion(forged)).toEqual({
        kind: "compare",
        operator: "=",
        value: forged,
      });
    });
  });
});

describe("qualifier", () => {
  it("prefixes every column with the quoted alias on SQLite", () => {
    const result = buildSearchWhere<Row>(
      SqliteDialect,
      { id: "abc", value: { value: 1, operator: ">" } },
      schemaProps,
      passthroughConvert,
      1,
      "r"
    );
    expect(result.whereClause).toBe("`r`.`id` = ? AND `r`.`value` > ?");
    expect(result.params).toEqual(["abc", 1]);
  });

  it("keeps the one-array-parameter rule for an in-list on Postgres", () => {
    const result = buildSearchWhere<Row>(
      PostgresDialect,
      { value: { value: [1, 2], operator: "in" } },
      schemaProps,
      passthroughConvert,
      3,
      "r"
    );
    expect(result.whereClause).toBe('"r"."value" = ANY($3)');
    expect(result.params).toEqual([[1, 2]]);
  });

  it("qualifies the IS NULL rewrite and binds nothing for it", () => {
    const result = buildSearchWhere<Row>(
      PostgresDialect,
      { id: null as unknown as string, value: 2 },
      schemaProps,
      passthroughConvert,
      1,
      "l"
    );
    expect(result.whereClause).toBe('"l"."id" IS NULL AND "l"."value" = $1');
    expect(result.params).toEqual([2]);
  });

  it("quotes an alias that needs escaping", () => {
    const result = buildSearchWhere<Row>(
      SqliteDialect,
      { id: "x" },
      schemaProps,
      passthroughConvert,
      1,
      "we`ird"
    );
    expect(result.whereClause).toBe("`we``ird`.`id` = ?");
  });

  it("is byte-identical to the unqualified output when omitted", () => {
    const criteria = { id: "abc", value: { value: [1, 2, 3], operator: "in" as const } };
    for (const dialect of [SqliteDialect, PostgresDialect, DuckDbDialect]) {
      const plain = buildSearchWhere<Row>(dialect, criteria, schemaProps, passthroughConvert, 2);
      const explicit = buildSearchWhere<Row>(
        dialect,
        criteria,
        schemaProps,
        passthroughConvert,
        2,
        undefined
      );
      expect(explicit).toEqual(plain);
    }
  });

  describe("like criteria", () => {
    it("renders a bare `col LIKE $n ESCAPE '\\'` on Postgres, nothing around the column", () => {
      // A bare column is what lets a pg_trgm GIN or text_pattern_ops index
      // serve the predicate; a cast or function around it would not.
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { value: 1, id: { value: "%5.02%", operator: "like" } },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe(`"value" = $1 AND "id" LIKE $2 ESCAPE '\\'`);
      expect(result.params).toEqual([1, "%5.02%"]);
    });

    it("renders the same on DuckDB, starting from the caller's index", () => {
      const result = buildSearchWhere<Row>(
        DuckDbDialect,
        { id: { value: "a\\_b%", operator: "like" } },
        schemaProps,
        passthroughConvert,
        4
      );
      expect(result.whereClause).toBe(`"id" LIKE $4 ESCAPE '\\'`);
      expect(result.params).toEqual(["a\\_b%"]);
    });

    it("translates to a case-sensitive GLOB on SQLite", () => {
      const result = buildSearchWhere<Row>(
        SqliteDialect,
        { id: { value: "a%b_c*d?e[f\\%g\\_", operator: "like" } },
        schemaProps,
        passthroughConvert
      );
      expect(result.whereClause).toBe("`id` GLOB ?");
      expect(result.params).toEqual(["a*b?c[*]d[?]e[[]f%g_"]);
    });

    it("binds the pattern as given, not through convertValue", () => {
      const result = buildSearchWhere<Row>(
        PostgresDialect,
        { createdAt: { value: "2026-%", operator: "like" } },
        schemaProps,
        () => {
          throw new Error("convertValue must not see a like pattern");
        }
      );
      expect(result.params).toEqual(["2026-%"]);
    });

    it("normalizes to its own kind and is not a comparison operator", () => {
      expect(normalizeCriterion({ value: "x%", operator: "like" })).toEqual({
        kind: "like",
        pattern: "x%",
      });
      expect(isSearchCondition({ value: "x%", operator: "like" })).toBe(false);
      expect(isSearchLikeCondition({ value: "x%", operator: "like" })).toBe(true);
      expect(isSearchLikeCondition({ value: 5, operator: "like" })).toBe(false);
    });
  });
});
