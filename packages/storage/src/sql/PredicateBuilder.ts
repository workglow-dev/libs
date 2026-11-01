/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type DeleteSearchCriteria,
  normalizeCriterion,
  SEARCH_OPERATOR_SET,
  type ValueOptionType,
} from "../tabular/ITabularStorage";
import type { ISqlDialect } from "./Dialect";

/**
 * Result of {@link buildSearchWhere} — a parameterized WHERE-clause body
 * (without the leading `WHERE` keyword) and its ordered parameters.
 *
 * `params.length` is the number of placeholders consumed, which is no longer
 * the number of criteria columns: an `in` / `not-in` criterion binds one
 * parameter per value on SQLite and exactly one (an array) on Postgres, and an
 * empty list of either binds none at all. Callers deriving a next-placeholder
 * index must use `startIndex + params.length`, never the criteria key count.
 */
export interface BuiltWhereClause {
  readonly whereClause: string;
  readonly params: ValueOptionType[];
}

/**
 * Builds a parameterized AND-joined WHERE clause from a {@link DeleteSearchCriteria}.
 * Used by every SQL tabular backend so the operator handling stays consistent.
 *
 * @param dialect       Identifier-quoting, placeholder, and IN-list rules for the target DB.
 * @param criteria      Per-column equality value, comparison condition,
 *                      `in` / `not-in` list, or `like` pattern.
 * @param schemaProps   Schema property bag — unknown columns throw, preventing
 *                      callers from accidentally letting user input pick a column.
 * @param convertValue  Backend-specific JS-to-SQL coercion (e.g. boolean → 0/1).
 *                      Applied per element for a list.
 * @param startIndex    1-based starting parameter index (defaults to 1).
 *                      PostgreSQL callers use this when other params have already
 *                      been bound; SQLite ignores it because placeholders are positional.
 * @param qualifier     Table alias to prefix every column with (`"l"."col"`), for
 *                      statements that name more than one table. Omitted, the
 *                      output is exactly what a single-table caller gets today.
 */
export function buildSearchWhere<Entity>(
  dialect: ISqlDialect,
  criteria: DeleteSearchCriteria<Entity>,
  schemaProps: Record<string, unknown>,
  convertValue: (column: string, value: Entity[keyof Entity]) => ValueOptionType,
  startIndex: number = 1,
  qualifier?: string
): BuiltWhereClause {
  const conditions: string[] = [];
  const params: ValueOptionType[] = [];
  let paramIndex = startIndex;

  for (const column of Object.keys(criteria) as Array<keyof Entity>) {
    if (!(column in schemaProps)) {
      throw new Error(`Schema must have a "${String(column)}" field to use it in search criteria`);
    }

    const quotedColumn =
      qualifier === undefined
        ? dialect.quoteId(String(column))
        : `${dialect.quoteId(qualifier)}.${dialect.quoteId(String(column))}`;
    const normalized = normalizeCriterion<Entity[keyof Entity]>(criteria[column]);

    if (normalized.kind === "in" || normalized.kind === "not-in") {
      // Each element goes through the same coercion a scalar value would, so
      // dates and booleans bind identically whether matched by `=` or `IN`.
      const values = normalized.values.map((v) => convertValue(column as string, v));
      const built =
        normalized.kind === "in"
          ? dialect.inPredicate(quotedColumn, values, paramIndex)
          : dialect.notInPredicate(quotedColumn, values, paramIndex);
      conditions.push(built.sql);
      params.push(...built.params);
      // Not `+= values.length`: Postgres binds the whole list as one array
      // parameter, and an empty list of either kind degenerates to a constant
      // predicate binding nothing, so only the dialect knows how many
      // placeholders it used.
      paramIndex += built.params.length;
      continue;
    }

    if (normalized.kind === "like") {
      // Bound as given, not through `convertValue`: a pattern is not a column
      // value, and coercing it (a date column parsing it, say) would change it.
      const built = dialect.likePredicate(quotedColumn, normalized.pattern, paramIndex);
      conditions.push(built.sql);
      params.push(...built.params);
      paramIndex += built.params.length;
      continue;
    }

    const { operator, value } = normalized;

    // Defense-in-depth: `normalizeCriterion` already gates `operator` to the
    // allow-list, but this is the spot where the operator is interpolated
    // raw into SQL, so re-verify here. Unreachable from typed callers; this
    // catches `as unknown as` bypasses and any future refactor that loosens
    // the guards before the operator reaches the builder.
    if (!SEARCH_OPERATOR_SET.has(operator)) {
      throw new Error(`Unsupported SearchCondition operator: ${String(operator)}`);
    }

    // `col = NULL` is never true in SQL — not even against a NULL column — so a
    // null criterion used to match zero rows instead of the rows holding NULL.
    // That failed silently and in the worst possible direction: a repo looking
    // up a row by a tuple containing a nullable column always missed, and
    // callers that "find or create" therefore created every time. One such
    // resolver minted 6 canonical identities for a single person in one run.
    //
    // Only equality and its negation are rewritten. An ordering comparison
    // against NULL is
    // unknown by definition, so `<`/`>` keep matching nothing — which is what
    // SQL means — rather than being quietly redefined here.
    //
    // `undefined` is deliberately NOT folded in: it is indistinguishable from
    // "caller omitted this filter", and guessing between the two would trade a
    // visible bug for an invisible one.
    if (value === null && (operator === "=" || operator === "!=")) {
      // Binds no parameter, so paramIndex must not advance.
      conditions.push(`${quotedColumn} IS ${operator === "=" ? "" : "NOT "}NULL`);
      continue;
    }

    conditions.push(`${quotedColumn} ${operator} ${dialect.placeholder(paramIndex)}`);
    params.push(convertValue(column as string, value));
    paramIndex++;
  }

  return {
    whereClause: conditions.join(" AND "),
    params,
  };
}
