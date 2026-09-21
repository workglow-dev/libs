/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CoveringIndexQueryOptions,
  DeleteSearchCriteria,
  JoinSpec,
  OrderBy,
  PageRequest,
  QueryOptions,
  SearchCriteria,
} from "./ITabularStorage";
import {
  ALLOWED_SEARCH_OPERATORS,
  isSearchCondition,
  isSearchInCondition,
  isSearchNotInCondition,
  JOIN_SIDE_SET,
  JOIN_TYPE_SET,
  JoinSides,
  JoinTypes,
  normalizeCriterion,
  SEARCH_OPERATOR_SET,
} from "./ITabularStorage";
import {
  StorageEmptyCriteriaError,
  StorageInvalidColumnError,
  StorageInvalidLimitError,
  StorageUnfilteredDeleteError,
  StorageValidationError,
} from "./StorageError";

/** The `properties` map of the storage's full (primary key + value) schema. */
export type SchemaProperties = Record<string, unknown>;

/**
 * Validates the `orderBy` clause of a page/query request: column names must
 * exist in the schema and directions must be `"ASC"` or `"DESC"`.
 */
export function validateOrderBy<Entity>(
  schemaProperties: SchemaProperties,
  orderBy: ReadonlyArray<OrderBy<Entity>> | undefined
): void {
  if (!orderBy) return;
  const validDirections = ["ASC", "DESC"];
  for (const { column, direction } of orderBy) {
    if (typeof column !== "string") {
      throw new StorageInvalidColumnError(String(column));
    }
    if (!(column in schemaProperties)) {
      throw new StorageInvalidColumnError(String(column));
    }
    if (!validDirections.includes(direction)) {
      throw new StorageValidationError(
        `Invalid sort direction "${direction}". Must be "ASC" or "DESC"`
      );
    }
  }
}

/**
 * Whether a criterion claims one of the list operators (`"in"`, `"not-in"`)
 * without carrying an array. Both are checked in one place so a new list
 * operator cannot be added to the union and validated for only one of them.
 */
function isMalformedListCriterion(criterion: unknown): boolean {
  if (typeof criterion !== "object" || criterion === null) return false;
  const operator = (criterion as { operator?: unknown }).operator;
  if (operator !== "in" && operator !== "not-in") return false;
  return !isSearchInCondition(criterion) && !isSearchNotInCondition(criterion);
}

/**
 * Validates query parameters: criteria columns, options, and operator values.
 * `validateOrderByFn` is the caller's (overridable) order-by validator, so a
 * subclass that tightens `validateOrderBy` still runs here.
 */
export function validateQueryParams<Entity>(
  schemaProperties: SchemaProperties,
  criteria: SearchCriteria<Entity>,
  options: QueryOptions<Entity> | undefined,
  validateOrderByFn: (orderBy: ReadonlyArray<OrderBy<Entity>> | undefined) => void
): void {
  const criteriaKeys = Object.keys(criteria) as Array<keyof Entity>;

  if (criteriaKeys.length === 0) {
    throw new StorageEmptyCriteriaError();
  }

  if (options?.limit !== undefined && options.limit <= 0) {
    throw new StorageInvalidLimitError(options.limit);
  }

  if (options?.offset !== undefined && options.offset < 0) {
    throw new StorageValidationError(`Query offset must be non-negative, got ${options.offset}`);
  }

  validateCriteriaColumns(schemaProperties, criteria);

  validateOrderByFn(options?.orderBy);
}

/**
 * Validates the columns and operators of a criteria bag without requiring it
 * to be non-empty — the per-column half of {@link validateQueryParams}, shared
 * with join specs whose per-side filters are optional.
 */
export function validateCriteriaColumns<Entity>(
  schemaProperties: SchemaProperties,
  criteria: SearchCriteria<Entity>
): void {
  for (const column of Object.keys(criteria) as Array<keyof Entity>) {
    if (!(column in schemaProperties)) {
      throw new StorageInvalidColumnError(String(column));
    }
    const criterion = criteria[column];
    if (isSearchCondition(criterion)) {
      // Read from the shared allow-list rather than a local copy: a literal
      // here silently rejects any operator added to the union, which is exactly
      // how `!=` came to be unreachable despite every backend implementing it.
      if (!SEARCH_OPERATOR_SET.has(criterion.operator)) {
        throw new StorageValidationError(
          `Invalid operator "${criterion.operator}". Must be one of: ` +
            ALLOWED_SEARCH_OPERATORS.join(", ")
        );
      }
    } else if (isMalformedListCriterion(criterion)) {
      // A list criterion whose value is not an array passes neither guard, so
      // it would fall through to `normalizeCriterion` as a literal value and
      // match nothing. Nobody means that — fail loudly instead, and note that
      // for `not-in` "matches nothing" is the opposite of what was asked for.
      const operator = (criterion as { operator: string }).operator;
      throw new StorageValidationError(
        `Criterion for column "${String(column)}" uses operator "${operator}" ` +
          `but its value is not an array`
      );
    }
  }
}

/**
 * Validates a {@link JoinSpec} before any of it is quoted into SQL. The spec
 * crosses the same JSON trust boundary as query criteria (HTTP-proxied
 * storages), so `type`, `side` and `direction` are checked against their
 * allow-lists rather than trusted from the static type.
 *
 * `rightProperties` is `undefined` when the right storage does not expose its
 * schema (a third-party wrapper); its own `query` still validates whatever the
 * hash join hands it, and the SQL path always has both schemas in hand.
 */
export function validateJoinSpec<L, R>(
  leftProperties: SchemaProperties,
  rightProperties: SchemaProperties | undefined,
  spec: JoinSpec<L, R>
): void {
  if (!JOIN_TYPE_SET.has(spec.type)) {
    throw new StorageValidationError(
      `Invalid join type "${String(spec.type)}". Must be one of: ` +
        Object.values(JoinTypes).join(", ")
    );
  }
  if (!Array.isArray(spec.on) || spec.on.length === 0) {
    throw new StorageValidationError("Join spec must name at least one column pair in `on`");
  }
  for (const pair of spec.on) {
    assertColumn(leftProperties, pair.left);
    assertColumn(rightProperties, pair.right);
  }
  if (spec.where?.left !== undefined) {
    validateCriteriaColumns(leftProperties, spec.where.left);
  }
  if (spec.where?.right !== undefined && rightProperties !== undefined) {
    validateCriteriaColumns(rightProperties, spec.where.right);
  }
  for (const { side, column, direction } of spec.orderBy ?? []) {
    if (!JOIN_SIDE_SET.has(side)) {
      throw new StorageValidationError(
        `Invalid join side "${String(side)}". Must be one of: ` +
          Object.values(JoinSides).join(", ")
      );
    }
    const properties = side === JoinSides.left ? leftProperties : rightProperties;
    // The column check has to run even when that side's schema is unknown, so
    // it stays here; the rest is exactly the single-table rule.
    assertColumn(properties, column);
    if (properties !== undefined) {
      validateOrderBy(properties, [{ column: column as never, direction }]);
    } else if (direction !== "ASC" && direction !== "DESC") {
      throw new StorageValidationError(
        `Invalid sort direction "${String(direction)}". Must be "ASC" or "DESC"`
      );
    }
  }
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit <= 0)) {
    throw new StorageInvalidLimitError(spec.limit);
  }
  if (spec.offset !== undefined && (!Number.isInteger(spec.offset) || spec.offset < 0)) {
    throw new StorageValidationError(`Query offset must be non-negative, got ${spec.offset}`);
  }
}

/**
 * A column name must be a string, and must exist in the schema when one is
 * known. Membership is `Object.hasOwn`, not `in`: a schema's `properties` is a
 * plain object, so `in` also answers true for every `Object.prototype` key, and
 * a join spec arriving over the HTTP-proxy JSON boundary can name `constructor`
 * or `toString` as a column. Those passed validation and reached the SQL
 * builder, where they became a driver error instead of the intended
 * {@link StorageInvalidColumnError}.
 */
function assertColumn(properties: SchemaProperties | undefined, column: unknown): void {
  if (typeof column !== "string") {
    throw new StorageInvalidColumnError(String(column));
  }
  if (properties !== undefined && !Object.hasOwn(properties, column)) {
    throw new StorageInvalidColumnError(column);
  }
}

/**
 * Whether `criteria` can match no row at all, decided locally.
 *
 * For the backends that hand criteria to something else — an HTTP peer, a
 * PostgREST URL — where a criterion's meaning would not survive the trip:
 *
 * - An `undefined` compare value matches nothing (it binds as NULL, and
 *   `col = NULL` is never true). `JSON.stringify` drops the key outright, and
 *   a PostgREST filter would carry the literal text `undefined`, so neither
 *   peer can be asked the question — but the answer is known without asking.
 * - An `in` list with no non-null value, and a `not-in` list holding a `null`,
 *   both name nothing for the reasons on {@link SearchInCondition} and
 *   {@link SearchNotInCondition}.
 *
 * Backends that build their own SQL do not need this: they bind the value and
 * the database reaches the same answer.
 */
export function criteriaMatchNoRow<Entity>(
  criteria: DeleteSearchCriteria<Entity> | undefined
): boolean {
  if (!criteria) return false;
  for (const column of Object.keys(criteria) as Array<keyof Entity>) {
    const normalized = normalizeCriterion<Entity[keyof Entity]>(criteria[column]);
    if (normalized.kind === "compare") {
      if (normalized.value === undefined) return true;
      continue;
    }
    const nullish = (value: unknown): boolean => value === null || value === undefined;
    if (normalized.kind === "in" && normalized.values.every(nullish)) return true;
    if (normalized.kind === "not-in" && normalized.values.some(nullish)) return true;
  }
  return false;
}

/**
 * The identity emitted on the `delete` event for a bulk `deleteSearch`: the
 * plain (operator-free) columns of the criteria — which include the owner /
 * scope columns — as a `Partial<Entity>`. Search conditions are dropped since
 * they don't identify a concrete value.
 *
 * A free function rather than only a protected method, because a wrapper that
 * implements `ITabularStorage` without extending `BaseTabularStorage` owes its
 * subscribers the same event a concrete backend emits, and cannot reach a
 * protected member to build it.
 */
export function deleteSearchIdentity<Entity>(
  criteria: DeleteSearchCriteria<Entity>
): Partial<Entity> {
  const identity: Record<string, unknown> = {};
  for (const [column, criterion] of Object.entries(criteria)) {
    // A list criterion identifies no single value, so it is dropped for the
    // same reason a comparison condition is — otherwise the raw condition
    // object would be emitted as if it were the column's value. Both list
    // guards are required: `not-in` passes neither of the other two.
    if (
      !isSearchCondition(criterion) &&
      !isSearchInCondition(criterion) &&
      !isSearchNotInCondition(criterion)
    ) {
      identity[column] = criterion;
    }
  }
  return identity as Partial<Entity>;
}

/**
 * Whether a `deleteSearch` should run at all, throwing when its criteria would
 * take the whole table with them.
 *
 * Every backend opens `deleteSearch` with this so the three answers cannot
 * drift apart between them:
 *
 * - **No criteria → `false`**, the long-standing silent no-op. `deleteSearch({})`
 *   has never been a way to spell `deleteAll()`, and an empty WHERE is the one
 *   thing it must not become.
 * - **Criteria that all match every row → throw.** Today that is a set made up
 *   only of empty `not-in` lists. Excluding nothing is a faithful match-all —
 *   the SQL backends render it `1 = 1`, and for `query` or `count` it is the
 *   right answer — but on a delete it reads exactly like a filter that went
 *   missing, and exclusion lists are usually caller-supplied. A mix is fine:
 *   `{ tenant: "acme", excluded: { operator: "not-in", value: [] } }` still
 *   names acme's rows, so it runs.
 * - **Anything else → `true`.**
 */
export function shouldRunDeleteSearch<Entity>(criteria: DeleteSearchCriteria<Entity>): boolean {
  const columns = Object.keys(criteria) as Array<keyof Entity>;
  if (columns.length === 0) return false;

  const excludesNothing = (column: keyof Entity): boolean => {
    const normalized = normalizeCriterion<Entity[keyof Entity]>(criteria[column]);
    return normalized.kind === "not-in" && normalized.values.length === 0;
  };
  // `every` stops at the first column that narrows anything, so the common
  // case normalizes one criterion rather than all of them and allocates no
  // intermediate array. Reaching the throw means every column matched, which
  // is why they can all be named.
  if (!columns.every(excludesNothing)) return true;
  throw new StorageUnfilteredDeleteError(columns.map(String));
}

/** Validates the limit/offset/orderBy of a `getAll` options bag. */
export function validateGetAllOptions<Entity>(
  options: QueryOptions<Entity> | undefined,
  validateOrderByFn: (orderBy: ReadonlyArray<OrderBy<Entity>> | undefined) => void
): void {
  if (!options) return;

  if (options.limit !== undefined && options.limit <= 0) {
    throw new StorageInvalidLimitError(options.limit);
  }

  if (options.offset !== undefined && options.offset < 0) {
    throw new StorageValidationError(`Query offset must be non-negative, got ${options.offset}`);
  }

  validateOrderByFn(options.orderBy);
}

/** Validates the limit and orderBy of a cursor-paginated request. */
export function validatePageRequest<Entity>(
  request: PageRequest<Entity>,
  validateOrderByFn: (orderBy: ReadonlyArray<OrderBy<Entity>> | undefined) => void
): void {
  if (request.limit !== undefined) {
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      throw new StorageInvalidLimitError(request.limit);
    }
  }
  validateOrderByFn(request.orderBy);
}

/**
 * Validates the `select` array in a covering-index query: throws when
 * `select` is empty or names a column that is not in the schema.
 */
export function validateSelect<Entity, K extends keyof Entity & string>(
  schemaProperties: SchemaProperties,
  options: CoveringIndexQueryOptions<Entity, K>
): void {
  if (!options.select || options.select.length === 0) {
    throw new StorageValidationError("queryIndex requires a non-empty select array");
  }
  const schemaProps = Object.keys(schemaProperties);
  for (const col of options.select) {
    const colStr = String(col);
    if (!schemaProps.includes(colStr)) {
      throw new StorageValidationError(`queryIndex select column "${colStr}" is not in schema`);
    }
  }
}
