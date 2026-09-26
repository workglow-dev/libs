/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EventParameters } from "@workglow/util";
import type {
  DataPortSchemaObject,
  FromSchema,
  TypedArraySchemaOptions,
} from "@workglow/util/schema";
import type { PageCursor } from "./Cursor";

export type { PageCursor } from "./Cursor";

export type ValueOptionType = string | number | bigint | boolean | null | Uint8Array;

export type TabularEventListeners<PrimaryKey, Entity> = {
  put: (entity: Entity) => void;
  get: (key: PrimaryKey, entity: Entity | undefined) => void;
  /**
   * NOTE: backends that implement `getBulk` as a fan-out over per-key `get`
   * (the default {@link BaseTabularStorage.getBulk}, used by InMemory) ALSO
   * emit one `get` event per key in addition to this single `getBulk`.
   * Push-down backends (SQL `WHERE pk IN (...)`, and the KV-over-tabular path)
   * emit only `getBulk`. Instrumentation that counts reads via `get` events
   * must account for this backend-dependent fan-out.
   */
  getBulk: (keys: readonly PrimaryKey[], entities: readonly Entity[]) => void;
  query: (key: Partial<Entity>, entities: Entity[] | undefined) => void;
  /**
   * `key` identifies what was deleted, as a {@link Partial} of the entity: the
   * primary key for a single delete, or the (owner-bearing) criteria / matched
   * row for a bulk `deleteSearch`. It carries the scope columns so subscribers
   * can filter and caches can invalidate without the backend reading the row.
   */
  delete: (key: Partial<Entity>) => void;
  /**
   * Fired by {@link ITabularStorage.deleteAll}. NOTE: the KV surface emits the
   * same clear-the-store concept under a different name (`deleteall`, see
   * {@link KvEventListeners}). Subscribing at an abstraction boundary that spans
   * both tabular and KV stores must account for both identifiers.
   */
  clearall: () => void;
  /**
   * Emitted when an atomic batch op (`putBulk`) detects a mid-batch failure and
   * restores prior state. Subscribers should treat any uncommitted `put` events
   * from the failed batch as superseded and reconcile against the post-rollback
   * state.
   *
   * **Support is backend-dependent.** Backends that can cheaply snapshot and
   * restore their mutable state honor an all-or-nothing `putBulk` and emit this
   * event on failure: the in-memory family (`InMemoryTabularStorage`, its vector
   * overlay, and `SharedInMemoryTabularStorage`, which delegates to an inner
   * in-memory repo) and the IndexedDB transactional batch. Backends whose batch
   * is a non-atomic fan-out — notably `FsFolderTabularStorage` (per-file writes
   * with no snapshot) — do NOT emit `rollback`; a mid-batch failure there leaves
   * earlier rows committed. Subscribers that rely on rollback for correctness
   * must confirm the concrete backend supports it.
   *
   * `ids` carries the primary keys of rows that were observably committed (via
   * a per-row `put` event or backend-level write) before the failure, in the
   * order they were written. Subscribers can use the list to surgically
   * invalidate caches without re-reading the whole table. The list is empty
   * when no row reached the backend / emitted a `put` event before the throw
   * (e.g. an IndexedDB transaction that aborted before any `tx.oncomplete`).
   */
  rollback: (reason: {
    readonly op: string;
    readonly error: unknown;
    readonly ids: readonly PrimaryKey[];
  }) => void;
};

export type TabularEventName = keyof TabularEventListeners<any, any>;
export type TabularEventListener<
  Event extends TabularEventName,
  PrimaryKey,
  Entity,
> = TabularEventListeners<PrimaryKey, Entity>[Event];

export type TabularEventParameters<
  Event extends TabularEventName,
  PrimaryKey,
  Entity,
> = EventParameters<TabularEventListeners<PrimaryKey, Entity>, Event>;

export type TabularChangeType = "INSERT" | "UPDATE" | "DELETE";

export interface TabularChangePayload<Entity> {
  readonly type: TabularChangeType;
  readonly old?: Entity;
  readonly new?: Entity;
}

export interface TabularSubscribeOptions {
  /** Polling interval in milliseconds (used by implementations that rely on polling) */
  readonly pollingIntervalMs?: number;
}

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type SearchOperator = "=" | "!=" | "<" | "<=" | ">" | ">=";

/**
 * Closed allow-list of SQL comparison operators that can be interpolated
 * into a WHERE clause. This is the single source of truth: if
 * {@link SearchOperator} changes, this constant and {@link SEARCH_OPERATOR_SET}
 * must update in lockstep so SQL builders cannot accidentally accept a value
 * outside the union (defense in depth at the JSON trust boundary used by
 * HTTP-proxied storage backends).
 *
 * The list operators (`"in"`, `"not-in"`) are deliberately absent: they take a
 * list rather than a scalar and are rendered by dedicated dialect methods, so
 * neither may reach the code path that interpolates an operator raw into SQL.
 * See {@link isSearchInCondition} / {@link isSearchNotInCondition}.
 */
export const ALLOWED_SEARCH_OPERATORS = ["=", "!=", "<", "<=", ">", ">="] as const;

/** Set form of {@link ALLOWED_SEARCH_OPERATORS} for O(1) membership checks. */
export const SEARCH_OPERATOR_SET: ReadonlySet<SearchOperator> = new Set(ALLOWED_SEARCH_OPERATORS);

export interface SearchCondition<T> {
  readonly value: T;
  readonly operator: SearchOperator;
}

/**
 * Set-membership criterion — `column IN (…)`. Split from
 * {@link SearchCondition} rather than widening its `value` because only this
 * operator takes a list, and a shared `value` would let every scalar operator
 * accept an array.
 *
 * An empty `value` matches nothing (`IN ()` is a syntax error in SQL, so
 * backends emit an always-false predicate instead).
 *
 * A null or absent column never matches, and listing `null` does not change
 * that: SQL reads `NULL IN (…)` and `x IN (NULL)` alike as UNKNOWN. Ask for
 * null rows with `{ operator: "=", value: null }`, which the predicate builder
 * rewrites to `IS NULL`.
 */
export interface SearchInCondition<T> {
  readonly value: readonly T[];
  readonly operator: "in";
}

/**
 * Set-exclusion criterion — `column NOT IN (…)`, the complement of
 * {@link SearchInCondition}. Separate for the same reason: it takes a list,
 * not a scalar.
 *
 * Three behaviours follow SQL's three-valued logic rather than JavaScript's,
 * for the reason spelled out on {@link matchesInequalityCriterion} — the same
 * criterion must return the same rows on Postgres and on the in-memory
 * backend:
 *
 * - **A null (or absent) column never matches a non-empty list.** `NULL NOT IN
 *   (1, 2)` is UNKNOWN, so SQL excludes the row. Add an explicit
 *   `{ operator: "=", value: null }` on another pass if you want those rows.
 * - **A `null` anywhere in the list matches nothing at all.** `col NOT IN (1,
 *   NULL)` is UNKNOWN for every row that isn't already excluded by `1`, so no
 *   row can satisfy it. This is SQL's most notorious footgun; it is reproduced
 *   rather than papered over, because a backend that silently dropped the null
 *   would disagree with the database it is standing in for.
 * - **An empty `value` matches everything**, being a vacuously true conjunction
 *   of zero comparisons — the exact complement of the empty `in` list, which
 *   matches nothing. That is the right answer for `query` and `count`; on
 *   `deleteSearch` it would be a full-table delete, so criteria that reduce to
 *   nothing but empty exclusions are refused there with a
 *   {@link StorageUnfilteredDeleteError}. Use `deleteAll()` to mean it.
 */
export interface SearchNotInCondition<T> {
  readonly value: readonly T[];
  readonly operator: "not-in";
}

/**
 * Criteria for query/deleteSearch operations supporting multiple columns.
 * Each column can have a direct value (equality), a {@link SearchCondition}
 * with a comparison operator, or a {@link SearchInCondition} /
 * {@link SearchNotInCondition} list.
 *
 * @example
 * // Equality match
 * { category: "electronics" }
 *
 * // With operator
 * { createdAt: { value: date, operator: "<" } }
 *
 * // Set membership — one round trip instead of one query per id
 * { observation_id: { value: [1, 2, 3], operator: "in" } }
 *
 * // Set exclusion — everything but these ids
 * { observation_id: { value: [1, 2, 3], operator: "not-in" } }
 *
 * // Multiple columns
 * { category: "electronics", createdAt: { value: date, operator: "<" } }
 */
export type DeleteSearchCriteria<Entity> = {
  readonly [K in keyof Entity]?:
    | Entity[K]
    | SearchCondition<Entity[K]>
    | SearchInCondition<Entity[K]>
    | SearchNotInCondition<Entity[K]>;
};

export type SearchCriteria<Entity> = DeleteSearchCriteria<Entity>;

/**
 * A criterion resolved to exactly one shape. Backends switch on `kind` so
 * adding an operator family surfaces as a non-exhaustive switch rather than as
 * a criterion silently treated as a literal value.
 */
export type NormalizedCriterion<T> =
  | { readonly kind: "compare"; readonly operator: SearchOperator; readonly value: T }
  | { readonly kind: "in"; readonly values: readonly T[] }
  | { readonly kind: "not-in"; readonly values: readonly T[] };

/**
 * Whether a stored column value equals a criterion value, for the `=` operator.
 *
 * Exists so every non-SQL backend applies the same null rule the SQL backends
 * get from `IS NULL` rewriting in the predicate builder: a `null` criterion
 * matches a column that is null OR absent. The two spellings are the same state
 * — SQL stores an omitted column as NULL, while an in-memory row simply lacks
 * the key and reads back `undefined` — so a strict `===` matched nothing for
 * exactly the rows the caller was asking for.
 *
 * That mattered well beyond a missing row. A repo doing "look up by tuple, else
 * create" never found its own row when any column in the tuple was null, so it
 * created a duplicate on every call; the in-memory backend agreed with the
 * broken SQL behavior, so tests could not see it.
 *
 * **`undefined` is not `null`, and matches nothing.** A criterion of
 * `undefined` — what a spread optional filter leaves behind, `{ ...maybe }`
 * where `maybe` is `{ col: undefined }` — gets no `IS NULL` rewrite, because a
 * key present with no value cannot be told apart from a filter the caller
 * meant to omit, and guessing would trade a visible bug for an invisible one.
 * So it stays an ordinary equality, the SQL backends bind it as NULL, and
 * `col = NULL` is never true: no row matches, on any backend. The early return
 * here is what makes that true off SQL as well — read as a plain `===` this
 * matched rows whose column was absent, which is the answer no database gives.
 *
 * The consequence is worth stating plainly, because it is silent: a criteria
 * bag built by spreading an optional filter returns zero rows rather than
 * ignoring the filter. Omit the key when you mean "no filter", or pass `null`
 * when you mean IS NULL.
 */
export function matchesEqualityCriterion(columnValue: unknown, criterionValue: unknown): boolean {
  if (criterionValue === undefined) return false;
  if (criterionValue === null) return columnValue === null || columnValue === undefined;
  return columnValue === criterionValue;
}

/**
 * Whether a stored column value satisfies a `!=` criterion.
 *
 * Mirrors {@link matchesEqualityCriterion}, and deliberately follows SQL's
 * three-valued logic rather than JavaScript's `!==`:
 *
 * - `!= undefined` matches nothing, for the reason given above: it binds as
 *   NULL, and `col != NULL` is UNKNOWN.
 * - `!= null` means IS NOT NULL — it matches every row holding a value.
 * - `!= <value>` does NOT match a row whose column is null. In SQL
 *   `col != 'x'` is UNKNOWN when `col` is NULL, so the row is excluded, and a
 *   JS-native `!==` would include it. Diverging would make the same criterion
 *   return different rows on Postgres and on the in-memory backend, which is
 *   the one guarantee this abstraction exists to provide. Use an explicit
 *   `{ operator: "=", value: null }` alongside it to include nulls.
 */
export function matchesInequalityCriterion(columnValue: unknown, criterionValue: unknown): boolean {
  if (criterionValue === undefined) return false;
  const isNull = columnValue === null || columnValue === undefined;
  if (criterionValue === null) return !isNull;
  if (isNull) return false;
  return columnValue !== criterionValue;
}

/**
 * Whether a stored column value satisfies an `in` criterion.
 *
 * Strict membership, matching {@link matchesEqualityCriterion}'s `===`: no
 * coercion, so a string `"1"` never matches a numeric `1` on any backend.
 *
 * A null or absent column never matches, whatever the list holds — including a
 * list containing `null`. SQL reads `NULL IN (…)` as UNKNOWN and drops the row,
 * and the SQL backends bind the list straight to `IN` / `= ANY`, so a JS-native
 * `null === null` here would have made the same criterion return different rows
 * on Postgres and in memory. This is the one rule `=` does NOT share: a `null`
 * *criterion* under {@link matchesEqualityCriterion} deliberately does match a
 * null column, because SQL spells that `IS NULL` and the predicate builder
 * rewrites it. A list has no such rewrite — `IN (NULL)` stays UNKNOWN — so
 * `{ operator: "=", value: null }` remains the only way to ask for null rows.
 */
export function matchesInCriterion(columnValue: unknown, values: readonly unknown[]): boolean {
  if (columnValue === null || columnValue === undefined) return false;
  return values.some((candidate) => columnValue === candidate);
}

/**
 * Whether a stored column value satisfies a `not-in` criterion.
 *
 * NOT the negation of {@link matchesInCriterion}: SQL's three-valued logic
 * drops a row from both when the comparison is UNKNOWN, so a null column fails
 * `in` and `not-in` alike. That is the whole reason this is a shared helper
 * rather than a `!` in each backend. See {@link SearchNotInCondition} for why
 * each rule is what it is:
 *
 * - Empty list → true (a vacuous conjunction of zero `<>` tests).
 * - Null or absent column, non-empty list → false (UNKNOWN, so SQL drops it).
 * - `null` present in the list → false for every row (UNKNOWN again).
 * - Otherwise → true when the value equals no listed value.
 */
export function matchesNotInCriterion(columnValue: unknown, values: readonly unknown[]): boolean {
  if (values.length === 0) return true;
  if (columnValue === null || columnValue === undefined) return false;
  // One pass, not two `some` scans: this runs per row on the in-memory and
  // IndexedDB filters, so the list is walked once. It cannot stop at the first
  // match either — a `null` later in the list makes the whole predicate
  // UNKNOWN and outranks a match already found.
  let excluded = false;
  for (const candidate of values) {
    if (candidate === null || candidate === undefined) return false;
    if (columnValue === candidate) excluded = true;
  }
  return !excluded;
}

/**
 * Resolves a raw criterion — bare value, {@link SearchCondition},
 * {@link SearchInCondition}, or {@link SearchNotInCondition} — into a
 * {@link NormalizedCriterion}.
 *
 * Every backend should route through this rather than testing the guards
 * itself: a backend that only checks `isSearchCondition` treats a list
 * criterion as a literal `{value, operator}` object and silently matches
 * nothing, which is the worst possible failure for a filter.
 */
export function normalizeCriterion<T>(criterion: unknown): NormalizedCriterion<T> {
  if (isSearchInCondition<T>(criterion)) {
    return { kind: "in", values: criterion.value };
  }
  if (isSearchNotInCondition<T>(criterion)) {
    return { kind: "not-in", values: criterion.value };
  }
  if (isSearchCondition<T>(criterion)) {
    return { kind: "compare", operator: criterion.operator, value: criterion.value };
  }
  return { kind: "compare", operator: "=", value: criterion as T };
}

export type SortDirection = "ASC" | "DESC";

export interface OrderBy<Entity> {
  readonly column: keyof Entity;
  readonly direction: SortDirection;
}

export interface QueryOptions<Entity> {
  readonly orderBy?: ReadonlyArray<OrderBy<Entity>>;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CoveringIndexQueryOptions<Entity, K extends keyof Entity & string> {
  readonly select: readonly K[];
  readonly orderBy?: ReadonlyArray<OrderBy<Entity>>;
  readonly limit?: number;
  readonly offset?: number;
}

export const JoinTypes = { inner: "inner", left: "left" } as const;
export type JoinType = (typeof JoinTypes)[keyof typeof JoinTypes];

/**
 * Set form of {@link JoinTypes} for O(1) allow-list checks. The join type is
 * interpolated raw into SQL (`LEFT JOIN` / `INNER JOIN`), so it is re-verified
 * at the JSON trust boundary the same way {@link SEARCH_OPERATOR_SET} is.
 */
export const JOIN_TYPE_SET: ReadonlySet<string> = new Set(Object.values(JoinTypes));

export const JoinSides = { left: "left", right: "right" } as const;
export type JoinSide = (typeof JoinSides)[keyof typeof JoinSides];

/** Set form of {@link JoinSides} for O(1) allow-list checks. */
export const JOIN_SIDE_SET: ReadonlySet<string> = new Set(Object.values(JoinSides));

/** One equality pair of the join condition: `left.<left> = right.<right>`. */
export interface JoinOn<L, R> {
  readonly left: keyof L & string;
  readonly right: keyof R & string;
}

/** An {@link OrderBy} that also names which side of the join the column is on. */
export interface JoinOrderBy {
  readonly side: JoinSide;
  readonly column: string;
  readonly direction: SortDirection;
}

/**
 * Per-side filters. `right` is applied as part of the join condition rather
 * than after it, so under a `left` join an unmatched left row survives a
 * right-side filter instead of being dropped by it.
 */
export interface JoinWhere<L, R> {
  readonly left?: SearchCriteria<L>;
  readonly right?: SearchCriteria<R>;
}

/**
 * Describes a two-table join. `on` pairs are AND-ed; a compound key is several
 * pairs. A join key that is `null` (or absent) on either side never matches,
 * as in SQL. `orderBy`, `limit` and `offset` apply to the joined rows.
 */
export interface JoinSpec<L, R, T extends JoinType = JoinType> {
  readonly type: T;
  readonly on: ReadonlyArray<JoinOn<L, R>>;
  readonly where?: JoinWhere<L, R>;
  readonly orderBy?: ReadonlyArray<JoinOrderBy>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * One row of a join result. The two sides stay nested rather than being
 * flattened, so same-named columns never collide and an unmatched left row
 * under a `left` join is an honest `right: undefined`.
 */
export interface JoinedRow<L, R, T extends JoinType = JoinType> {
  readonly left: L;
  readonly right: T extends "left" ? R | undefined : R;
}

/**
 * Request for a cursor-paginated read.
 *
 * Pagination is keyset-based: the next page resumes after the row encoded
 * in `cursor`, with the primary key acting as the stable tiebreaker.
 * This is stable under concurrent inserts and deletes — unlike offset-based
 * paging, which can skip or duplicate rows when the underlying data
 * shifts between calls.
 *
 * If `orderBy` is omitted, rows are returned in primary-key order ascending.
 * If `orderBy` is provided, the effective ordering is `[...orderBy, ...primaryKey]`
 * so iteration remains deterministic when sort columns contain duplicates.
 */
export interface PageRequest<Entity> {
  readonly orderBy?: ReadonlyArray<OrderBy<Entity>>;
  /** Maximum number of rows to return. Defaults to 100. */
  readonly limit?: number;
  /** Opaque cursor returned by a previous call; omit to start from the beginning. */
  readonly cursor?: PageCursor;
}

/**
 * A page of results from a cursor-paginated read.
 *
 * `nextCursor` is `undefined` when there are no more rows to fetch.
 * When `nextCursor` is present, callers should pass it back via
 * {@link PageRequest.cursor} to fetch the next page.
 *
 * **Termination contract.** A defined `nextCursor` does NOT guarantee
 * additional rows exist — concurrent deletes can produce an empty page
 * mid-iteration even though `nextCursor` was set. Loops MUST therefore
 * terminate on either condition, not just on `nextCursor`:
 *
 * ```ts
 * // CORRECT — terminates on both `nextCursor` and empty `items`:
 * let cursor: PageCursor | undefined;
 * do {
 *   const page = await storage.getPage({ limit: 100, cursor });
 *   for (const row of page.items) handle(row);
 *   if (page.items.length === 0) break;
 *   cursor = page.nextCursor;
 * } while (cursor);
 *
 * // WRONG — can spin forever if a concurrent delete empties the next page
 * // while leaving rows further along the cursor that get deleted in turn:
 * while (page.nextCursor) { page = await storage.getPage({ cursor: page.nextCursor }); }
 * ```
 *
 * The bundled async generators ({@link ITabularStorage.records},
 * {@link ITabularStorage.pages}) honour this contract; reach for them
 * instead of writing the loop manually.
 */
export interface Page<Entity> {
  readonly items: ReadonlyArray<Entity>;
  readonly nextCursor: PageCursor | undefined;
}

/**
 * Type guard to check if a value is a SearchCondition.
 *
 * Verifies the operator is a member of {@link ALLOWED_SEARCH_OPERATORS} so a
 * forged criterion (e.g. one decoded from JSON at an HTTP boundary) cannot
 * smuggle an arbitrary string into SQL via {@link buildSearchWhere}.
 */
export function isSearchCondition<T>(value: unknown): value is SearchCondition<T> {
  if (typeof value !== "object" || value === null) return false;
  if (!("value" in value) || !("operator" in value)) return false;
  const operator = (value as SearchCondition<T>).operator;
  if (typeof operator !== "string") return false;
  return SEARCH_OPERATOR_SET.has(operator as SearchOperator);
}

/**
 * Type guard for {@link SearchInCondition}.
 *
 * Deliberately separate from {@link isSearchCondition} so the scalar-operator
 * allow-list stays closed: `"in"` is never a member of
 * {@link ALLOWED_SEARCH_OPERATORS}, so it can never reach the code path that
 * interpolates an operator raw into SQL. The list shape is verified here for
 * the same reason the operator is — this is the JSON trust boundary for
 * HTTP-proxied backends, where a forged `{operator: "in", value: "…"}` must
 * not reach a query builder that assumes an array.
 */
export function isSearchInCondition<T>(value: unknown): value is SearchInCondition<T> {
  if (typeof value !== "object" || value === null) return false;
  if (!("value" in value) || !("operator" in value)) return false;
  if ((value as SearchInCondition<T>).operator !== "in") return false;
  return Array.isArray((value as SearchInCondition<T>).value);
}

/**
 * Type guard for {@link SearchNotInCondition}.
 *
 * Held to the same rule as {@link isSearchInCondition}, and for the same
 * threat: `"not-in"` stays out of {@link ALLOWED_SEARCH_OPERATORS} so a forged
 * criterion crossing the HTTP JSON boundary cannot smuggle it into the raw
 * operator interpolation in `buildSearchWhere`, and the array shape is checked
 * here so a forged `{operator: "not-in", value: "…"}` cannot reach a dialect
 * method that assumes a list.
 *
 * A criterion that fails the array check is NOT silently downgraded to a
 * literal — {@link validateQueryParams} rejects it, because a `not-in` quietly
 * read as an equality against a condition object matches nothing, which is the
 * wrong answer in the dangerous direction for an exclusion filter.
 */
export function isSearchNotInCondition<T>(value: unknown): value is SearchNotInCondition<T> {
  if (typeof value !== "object" || value === null) return false;
  if (!("value" in value) || !("operator" in value)) return false;
  if ((value as SearchNotInCondition<T>).operator !== "not-in") return false;
  return Array.isArray((value as SearchNotInCondition<T>).value);
}

/**
 * Helper type to compute PrimaryKey while deferring Entity resolution. Uses a
 * conditional type to avoid forcing full Entity resolution at class definition.
 */
export type SimplifyPrimaryKey<
  Entity,
  KeyName extends ReadonlyArray<keyof any>,
> = Entity extends any ? Pick<Entity, Extract<KeyName[number], keyof Entity>> : never;

/**
 * Extracts property names marked as auto-generated from the schema.
 * Properties with `x-auto-generated: true` are considered auto-generated.
 */
export type AutoGeneratedKeys<Schema extends DataPortSchemaObject> = {
  [K in keyof Schema["properties"]]: Schema["properties"][K] extends { "x-auto-generated": true }
    ? K
    : never;
}[keyof Schema["properties"]];

/** Entity type for insertion — properties marked auto-generated become optional. */
export type InsertEntity<Entity, AutoGenKeys> = Omit<Entity, AutoGenKeys & keyof Entity> &
  Partial<Pick<Entity, AutoGenKeys & keyof Entity>>;

/** What {@link ITabularStorage.putByUniqueKey} stored, and whether it inserted the row. */
export interface UniqueKeyPutResult<Entity> {
  readonly entity: Entity;
  readonly inserted: boolean;
}

/**
 * Interface defining the contract for tabular storage repositories.
 * Provides a flexible interface for storing and retrieving data with typed
 * primary keys and values, and supports compound keys and partial key lookup.
 *
 * @typeParam Schema - The schema definition for the entity using JSON Schema
 * @typeParam PrimaryKeyNames - Array of property names that form the primary key
 */
export interface ITabularStorage<
  Schema extends DataPortSchemaObject,
  PrimaryKeyNames extends ReadonlyArray<keyof Schema["properties"]>,
  // computed types
  Entity = FromSchema<Schema, TypedArraySchemaOptions>,
  PrimaryKey = SimplifyPrimaryKey<Entity, PrimaryKeyNames>,
  InsertType = InsertEntity<Entity, AutoGeneratedKeys<Schema>>,
> {
  put(value: InsertType): Promise<Entity>;
  /**
   * Stores `value` under the row it shares a UNIQUE key with — `put`, but
   * matched on `uniqueKey` rather than on the primary key.
   *
   * For a table whose primary key is a surrogate the caller does not know (an
   * auto-generated id) and whose identity is a natural key held by a unique
   * index. A row with the same `uniqueKey` values is overwritten in place,
   * keeping its primary key; otherwise `value` is inserted and its key
   * assigned as `put` would. Two writers of one key converge on one row.
   *
   * `uniqueKey` must name exactly the columns of one of the storage's declared
   * unique indexes, in any order, and `value` must carry a non-null value for
   * each — a null never matches under a SQL unique index, so the rows would
   * fork. Either failing throws before anything is written.
   *
   * @returns The stored row, primary key included, and whether it was
   *   inserted rather than an existing row overwritten — what a caller keeping
   *   rows keyed by this one needs to know to skip reading back rows a new
   *   row cannot have.
   * @emits "put" with the stored row, as `put` does.
   */
  putByUniqueKey(
    value: InsertType,
    uniqueKey: ReadonlyArray<keyof Entity>
  ): Promise<UniqueKeyPutResult<Entity>>;
  /**
   * Stores multiple entities in a single bulk operation.
   *
   * **Ordering guarantee:** the returned array is in the same order as the
   * input — `result[i]` always corresponds to `values[i]`. Callers may rely on
   * this to align bulk inserts with parallel arrays (e.g. chunks paired with
   * embeddings). Backends are responsible for preserving the order even when
   * the underlying engine does not formally guarantee it (see each backend's
   * implementation).
   *
   * **Caveat for integer auto-generated keys on remote backends.** Supplying
   * inputs that omit a backend-assigned integer-autoincrement primary key
   * leaves the wrapper with no key to match a returned row to a request row
   * (SQLite and DuckDB mint UUIDs client-side, so those don't have this
   * problem; Postgres server-fills UUID keys, so a UUID key omitted from the
   * input also falls back to response order). Such inputs fall back to the
   * server's response order, which Postgres does not formally contract for
   * `INSERT ... RETURNING`. The fallback is reliable in practice but if
   * `result[i] === values[i]` matters for correctness, supply the primary key
   * on every input — for example by minting it client-side — or split the
   * call into per-row `put`s.
   *
   * **Duplicate keys within one batch.** When the same primary key appears more
   * than once in `values`, the last occurrence wins and every position sharing
   * that key resolves to the single final committed row. SQL backends persist
   * the batch in one statement per chunk; a `put` event fires once per distinct
   * committed row.
   */
  putBulk(values: InsertType[]): Promise<Entity[]>;
  get(key: PrimaryKey): Promise<Entity | undefined>;
  /**
   * Fetches multiple entities by their primary keys in a single call.
   *
   * Returns only the entities that were found — the result is a filtered
   * array, not aligned with the input. Each returned entity carries its own
   * primary-key fields, so callers can re-align by key without a parallel
   * array. Result ordering is unspecified.
   *
   * Empty input returns an empty array without issuing a backend call.
   *
   * @param keys - Array of primary keys to look up
   * @returns Array of matching entities (possibly empty)
   */
  getBulk(keys: readonly PrimaryKey[]): Promise<Entity[]>;
  delete(key: PrimaryKey | Entity): Promise<void>;
  getAll(options?: QueryOptions<Entity>): Promise<Entity[] | undefined>;
  deleteAll(): Promise<void>;
  size(): Promise<number>;
  /** Counts rows matching `criteria` without loading the matching entities. */
  count(criteria?: SearchCriteria<Entity>): Promise<number>;
  /**
   * Deletes all entries matching the specified search criteria.
   * Supports multiple columns with optional comparison operators.
   *
   * @param criteria - Object with column names as keys and values or SearchConditions
   * @example
   * // Delete by equality
   * await repo.deleteSearch({ category: "electronics" });
   *
   * // Delete with operator
   * await repo.deleteSearch({ createdAt: { value: date, operator: "<" } });
   *
   * // Delete with multiple criteria (AND)
   * await repo.deleteSearch({ category: "electronics", value: { value: 100, operator: "<" } });
   */
  deleteSearch(criteria: DeleteSearchCriteria<Entity>): Promise<void>;

  /**
   * Atomically apply `patch` to a **single** row matching `match` and return
   * the updated row, or `undefined` when nothing matched. `match` uses the same
   * {@link SearchCriteria} shape as {@link query}/{@link deleteSearch} (AND of
   * per-column equality or `{ value, operator }` conditions). When several rows
   * match, exactly one (arbitrary) row is updated and returned — every backend
   * touches at most one row, so a non-unique `match` never bulk-mutates. Match
   * on a primary key or unique tuple when you need a specific row.
   *
   * `patch` must not include a primary-key column: this updates a row in place,
   * it does not move a row's identity (that is a delete + insert). Backends
   * throw {@link StorageValidationError} if the patch touches a key column.
   *
   * This is a genuine compare-and-set — safe under concurrent writers where a
   * read-then-`put` would race. SQL backends constrain the write to one row via
   * a `rowid`/`ctid` sub-select; Supabase resolves one matching primary key and
   * updates by it while re-applying `match`, so a concurrent change that breaks
   * the condition yields `undefined` rather than a stale write.
   */
  updateWhere(match: SearchCriteria<Entity>, patch: Partial<Entity>): Promise<Entity | undefined>;

  /** Offset-based paging; prefer {@link getPage} for stable iteration. */
  getOffsetPage(offset: number, limit: number): Promise<Entity[] | undefined>;

  /**
   * Fetches a page of records using cursor-based (keyset) pagination.
   *
   * Stable under concurrent inserts and deletes: the cursor encodes the
   * last seen primary key so the next page resumes from a precise position
   * rather than a numeric offset that shifts as rows are added or removed.
   *
   * @param request - Optional ordering, limit, and cursor.
   * @returns A {@link Page} with the rows for this page and a `nextCursor`
   *   to use for the next call (or `undefined` when iteration is complete).
   */
  getPage(request?: PageRequest<Entity>): Promise<Page<Entity>>;

  /**
   * Cursor-paginated form of {@link query}.
   *
   * @param criteria - Object with column names as keys and values or SearchConditions
   * @param request - Optional ordering, limit, and cursor.
   */
  queryPage(criteria: SearchCriteria<Entity>, request?: PageRequest<Entity>): Promise<Page<Entity>>;

  /** Async generator yielding records one at a time. */
  records(pageSize?: number): AsyncGenerator<Entity, void, undefined>;

  /** Async generator yielding pages of records. */
  pages(pageSize?: number): AsyncGenerator<Entity[], void, undefined>;

  on<Event extends TabularEventName>(
    name: Event,
    fn: TabularEventListener<Event, PrimaryKey, Entity>
  ): void;
  off<Event extends TabularEventName>(
    name: Event,
    fn: TabularEventListener<Event, PrimaryKey, Entity>
  ): void;
  emit<Event extends TabularEventName>(
    name: Event,
    ...args: TabularEventParameters<Event, PrimaryKey, Entity>
  ): void;
  once<Event extends TabularEventName>(
    name: Event,
    fn: TabularEventListener<Event, PrimaryKey, Entity>
  ): void;
  waitOn<Event extends TabularEventName>(
    name: Event
  ): Promise<TabularEventParameters<Event, PrimaryKey, Entity>>;

  /**
   * Queries entries matching the specified search criteria with optional ordering, limit, and offset.
   * Uses optimized index paths when possible, falls back to full scan otherwise.
   *
   * Implementation contract for third-party backends: when binding a
   * `SearchCondition` value into the underlying datastore, run it
   * through the same conversion path as a row value going *into* the
   * store (e.g. `jsToSqlValue` for SQL backends — Date → ISO string,
   * etc.). The cursor pagination machinery in {@link getPage} relies
   * on this round-trip to compare a row's stored representation
   * against a cursor's decoded value; any backend that skips the
   * conversion would silently mis-page on Date or other rich types.
   *
   * @param criteria - Object with column names as keys and values or SearchConditions
   * @param options - Optional ordering, limit, and offset options
   * @returns Array of matching entities or undefined if no matches found
   */
  query(
    criteria: SearchCriteria<Entity>,
    options?: QueryOptions<Entity>
  ): Promise<Entity[] | undefined>;

  /**
   * Strict, projected query served entirely by a covering compound index.
   * Throws CoveringIndexMissingError when no registered index can serve
   * (criteria + orderBy + select). Returns Pick<Entity, K>[] — never the heavy fields.
   *
   * @param criteria - equality (and optionally non-equality) filters
   * @param options  - select (required), orderBy, limit, offset
   * @returns array of projected rows (empty array, not undefined, when no matches)
   */
  queryIndex<K extends keyof Entity & string>(
    criteria: SearchCriteria<Entity>,
    options: CoveringIndexQueryOptions<Entity, K>
  ): Promise<Pick<Entity, K>[]>;

  /**
   * Joins this storage (the left side) to `right`. The default is an
   * application-side hash join over `query` and the `in` criterion, and the
   * SQL backends run one `JOIN` statement when both storages sit on the same
   * connection. A backend that cannot express the underlying reads throws
   * {@link StorageUnsupportedError} — today `FsFolderTabularStorage`, whose
   * `query` throws, and `HuggingFaceTabularStorage`, whose remote filter has
   * no `in` form. Either one used as the RIGHT side surfaces its own `query`
   * error instead, since that is the call the hash join actually makes.
   *
   * Rows come back nested as `{ left, right }`; under a `left` join an
   * unmatched left row carries `right: undefined`. A `null` join key never
   * matches. Returns `[]` (never `undefined`) when nothing matches. Emits no
   * event of its own.
   *
   * **What the fallback reads.** The single-statement path is bounded by the
   * database. The hash join is not, by default: `limit` and `offset` are
   * applied to the joined rows, so a bounded join can still be a whole-table
   * read. It bounds the left read — and stops early — only when the joined
   * rows come back in their final order, meaning `orderBy` is absent or names
   * only left columns the left query can order by. An `orderBy` touching the
   * right side, or a left column that may be null, is sorted in memory
   * instead, and that sort needs every joined row: such a join reads the whole
   * left table and every right row matching it, however small its `limit`.
   * Over a remote backend (HTTP proxy, Supabase) that is the whole table on
   * the wire, so prefer a `where.left` that narrows it, or an `orderBy` the
   * left side can serve.
   *
   * **An implementer runs `runTabularJoinContract`**
   * (`@workglow/test-contract/tabular-storage`), which supplies the two fixture
   * tables and inherits every assertion above — including, where both
   * strategies are reachable, that they return the same rows for the same spec.
   */
  join<R, T extends JoinType>(
    spec: JoinSpec<Entity, R, T>,
    right: ITabularStorage<any, any, R, any, any>
  ): Promise<JoinedRow<Entity, R, T>[]>;

  /**
   * Subscribes to changes in the repository (including remote changes).
   * @returns Unsubscribe function.
   */
  subscribeToChanges(
    callback: (change: TabularChangePayload<Entity>) => void,
    options?: TabularSubscribeOptions
  ): () => void;

  /**
   * Runs `fn` inside a single transaction. If `fn` throws, all writes performed
   * inside it are rolled back; otherwise they commit atomically. Mutation
   * events (e.g. `put`) emitted inside `fn` are buffered and delivered after
   * the transaction commits, so listeners never observe rows that are about
   * to roll back.
   *
   * Backends differ in how strong the guarantee is:
   *   - **SQLite**: real `BEGIN` / `COMMIT` / `ROLLBACK`.
   *   - **PostgreSQL**: real `BEGIN` / `COMMIT` / `ROLLBACK`. On a real
   *     `pg.Pool` (anything exposing `connect()`) the implementation
   *     dedicates a client via `pool.connect()` and runs the transaction on
   *     that client, leaving the parent's pool free for external traffic
   *     in parallel. On single-connection wrappers (PGLitePool, raw PGlite)
   *     the transaction runs on the shared session and concurrent calls on
   *     the same instance are serialized behind a per-instance mutex so
   *     they cannot slip into the open transaction.
   *   - **Supabase, in-memory, file system, IndexedDB**: best-effort. The
   *     callback runs to completion and rejection propagates, but partial
   *     writes are not rolled back because the backend does not expose a
   *     transaction surface usable by this API.
   *
   * **Concurrency contract:**
   *   - On backends with native transaction support (SQLite, PostgreSQL),
   *     concurrent calls on the same storage instance are isolated from the
   *     open transaction: SQLite and the single-connection Postgres path
   *     serialize them through a per-instance mutex; the real-pool Postgres
   *     path runs them on independent pool clients in parallel. Either way,
   *     unrelated writes never accidentally commit or roll back along with
   *     `fn`.
   *   - On best-effort backends concurrent writes have no atomicity barrier
   *     to begin with — the contract on those backends is "runs `fn`", not
   *     "isolates `fn`".
   *
   * The `tx` handle passed to `fn` is **not** the same object as `this` for
   * backends with native transaction support — it is a Proxy that routes
   * writes through the transaction-bound resources (the dedicated client on
   * real `pg.Pool`, the bypass-mutex internal methods on SQLite/PGlite) and
   * routes events through the transaction's deferred-emit queue. Callers
   * MUST use `tx` for everything inside `fn`. Capturing the outer `this` and
   * calling methods on it from inside `fn` will deadlock against the held
   * mutex (single-connection backends) or run on the wrong connection
   * (`pg.Pool`), and is unsupported.
   *
   * **Nested calls.** Calls made through the `tx` handle always throw —
   * `tx.withTransaction(...)` is a hard error on every backend. Calls made
   * through the *original* (captured `this`) handle behave per backend:
   *   - **SQLite, single-connection Postgres** (PGlite, PGLitePool): throw,
   *     because the backend has no autonomous `BEGIN` and reusing the open
   *     transaction implicitly would be ambiguous.
   *   - **Real `pg.Pool` Postgres**: acquire an *independent* client and run
   *     as an *independent* transaction with its own commit/rollback boundary.
   *     This is the natural Postgres concurrency model on a pool — nothing
   *     ties the two transactions together. If you want the inner work to
   *     roll back when the outer throws, do not use a captured `this`; use
   *     `tx` (which throws) and a SAVEPOINT instead.
   *
   * Use SAVEPOINT directly if you need nested rollback boundaries within a
   * single logical transaction.
   *
   * To commit writes across several storages that share one connection, use
   * the free function `withConnectionTransaction(participants, fn)` instead
   * of nesting `withTransaction` calls. Inside that callback, call ordinary
   * methods on the original instances (there is no `tx` proxy).
   */
  withTransaction<T>(fn: (tx: this) => Promise<T>): Promise<T>;

  /**
   * Creates the underlying table/object store. Idempotent: a second call on
   * an already-set-up storage adapts the schema to any new indexes if the
   * backend supports it (SQL `CREATE INDEX IF NOT EXISTS`, IndexedDB
   * version bump for new indexes), and is a no-op otherwise.
   *
   * When the storage was constructed with `tabularMigrations`, this method
   * also applies any pending migrations through the unified tabular
   * migration runner (see `TabularMigrationOrchestrator`). Otherwise it is
   * a pure DDL setup primitive — tabular schemas are derived from the JSON
   * Schema passed at construction rather than from versioned migrations.
   *
   * @returns Promise that resolves when setup is complete
   */
  setupDatabase(): Promise<void>;

  /**
   * Whether rows written to this storage survive a process restart. Optional:
   * backends that omit it are assumed durable. In-memory backends return
   * `false` so callers (e.g. the run-private cache durability check) can warn
   * when restart-survival won't actually hold.
   */
  isDurable?(): boolean;

  destroy(): void;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export type AnyTabularStorage = Omit<
  ITabularStorage<any, any, any, any, any>,
  "queryIndex" | "withTransaction" | "join"
> & {
  queryIndex(criteria: any, options: any): Promise<any[]>;
  withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  join(spec: any, right: any): Promise<any[]>;
};
