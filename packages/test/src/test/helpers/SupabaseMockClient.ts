/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asText, setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";

export interface IClosableSupabaseClient extends SupabaseClient {
  readonly close: () => Promise<void>;
}

/**
 * Translates a PostgREST `or=(...)` filter expression to a SQL WHERE
 * fragment for the mock client. Only handles the subset emitted by
 * {@link SupabaseTabularStorage} for cursor pagination:
 *
 *   - `col.eq.value`, `col.gt.value`, `col.lt.value`
 *   - `col.is.null`, `col.not.is.null`
 *   - `and(c1,c2,...)` and `or(c1,c2,...)` groupings
 *   - top-level comma-separated list = OR
 *   - values either bare (numbers, booleans) or `"..."`-wrapped with
 *     `\\`-escaped quotes/backslashes
 *
 * The mock backend is PGlite (real Postgres), so we emit standard SQL.
 */
/**
 * Only the top-level `.or()` filter shape used by `SupabaseTabularStorage`
 * is supported here, because that's all the production code ever emits;
 * adding `.and()` support would mean a different join here. Kept as a
 * single-purpose helper rather than a configurable one to avoid a dead
 * parameter that future callers might trust.
 */
function translatePostgrestFilter(filter: string): string {
  let i = 0;
  const s = filter;

  // Each list-style construct (top-level `.or(...)`, `and(...)`, `or(...)`)
  // joins its child expressions with its own operator. Returning each
  // child's pre-rendered SQL fragment and joining at the right level —
  // rather than splitting/rejoining a flat string — preserves the
  // structure of nested groups. Importantly, an `or(...)` group nested
  // inside an `and(...)` group keeps its `OR` operator instead of being
  // mistakenly rewritten to `AND`. SupabaseTabularStorage emits exactly
  // that shape for DESC keyset clauses (`and(eq.x, or(lt.y, is.null))`).
  function parseList(closingChar: string | null, joinOp: " AND " | " OR " = " OR "): string {
    const parts: string[] = [];
    while (i < s.length) {
      const part = parseExpr();
      if (part) parts.push(part);
      if (i < s.length && s[i] === ",") {
        i++;
        continue;
      }
      if (closingChar !== null && s[i] === closingChar) break;
      if (closingChar === null && i >= s.length) break;
      // Trailing whitespace is tolerated by PostgREST; skip it.
      while (i < s.length && /\s/.test(s[i])) i++;
    }
    return parts.join(joinOp);
  }

  function parseExpr(): string {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return "";
    if (s.startsWith("and(", i)) {
      i += 4;
      return `(${parseGroup(")", " AND ")})`;
    }
    if (s.startsWith("or(", i)) {
      i += 3;
      return `(${parseGroup(")", " OR ")})`;
    }
    return parseAtom();
  }

  function parseGroup(closingChar: string, joinOp: " AND " | " OR "): string {
    const parts: string[] = [];
    while (i < s.length && s[i] !== closingChar) {
      const part = parseExpr();
      if (part) parts.push(part);
      if (s[i] === ",") {
        i++;
      }
    }
    if (s[i] === closingChar) i++;
    return parts.join(joinOp);
  }

  function parseAtom(): string {
    // col.op.value (or col.op for col.is.null) — read until next `,`/`)`
    // unless inside a quoted value.
    let buf = "";
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        buf += ch;
        i++;
        while (i < s.length) {
          const c = s[i];
          buf += c;
          i++;
          if (c === "\\" && i < s.length) {
            buf += s[i];
            i++;
            continue;
          }
          if (c === '"') break;
        }
        continue;
      }
      if (ch === "," || ch === ")") break;
      buf += ch;
      i++;
    }
    return atomToSql(buf.trim());
  }

  function atomToSql(atom: string): string {
    // Patterns: col.not.is.null (tested first — strictly more specific
    // than `col.is.null`, otherwise the lazy `(.+?)` capture would match
    // a column name of `col.not`), col.is.null, col.OP.value.
    const notIsNullMatch = atom.match(/^(.+?)\.not\.is\.null$/);
    if (notIsNullMatch) return `"${notIsNullMatch[1]}" IS NOT NULL`;
    const isNullMatch = atom.match(/^(.+?)\.is\.null$/);
    if (isNullMatch) return `"${isNullMatch[1]}" IS NULL`;
    // Generic col.op.value — find the first dot, then the second.
    const firstDot = atom.indexOf(".");
    const secondDot = atom.indexOf(".", firstDot + 1);
    if (firstDot < 0 || secondDot < 0) {
      throw new Error(`Cannot parse PostgREST atom: ${atom}`);
    }
    const col = atom.slice(0, firstDot);
    const op = atom.slice(firstDot + 1, secondDot);
    const valueRaw = atom.slice(secondDot + 1);
    const sqlOp = ({ eq: "=", gt: ">", lt: "<", gte: ">=", lte: "<=" } as Record<string, string>)[
      op
    ];
    if (!sqlOp) throw new Error(`Unsupported PostgREST op in mock: ${op}`);
    let sqlValue: string;
    if (valueRaw.startsWith('"') && valueRaw.endsWith('"')) {
      // Unescape backslash-escaped chars in a single pass. The previous
      // two-step form (`replace(/\\\\/g, "\\")` then `replace(/\\"/g, '"')`)
      // double-unescapes input like `\\\"` — the first pass produces
      // `\\"`, which the second pass then turns into `"` instead of
      // `\"`. A single regex with a callback consumes each escape exactly
      // once.
      const unwrapped = valueRaw.slice(1, -1).replace(/\\(.)/g, (_m, ch) => ch);
      sqlValue = `'${unwrapped.replace(/'/g, "''")}'`;
    } else if (valueRaw === "true" || valueRaw === "false") {
      sqlValue = valueRaw;
    } else {
      sqlValue = valueRaw;
    }
    return `"${col}" ${sqlOp} ${sqlValue}`;
  }

  return parseList(null);
}

/**
 * Creates a mock Supabase client for testing that uses PGlite as the backend.
 * This provides a real PostgreSQL database for testing without needing a Supabase instance.
 */
/** SQL literal for one filter value, matching PostgREST's coercion. */
function mockSqlLiteral(val: any): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  if (typeof val === "string") return `'${val.replace(/'/g, "''")}'`;
  return String(val);
}

/**
 * Renders one accumulated filter into a WHERE term. Shared by the update,
 * delete, and select builders, which each used to inline the same coercion
 * ladder — three places for a new operator to be missed.
 */
function mockRenderFilter(f: { column: string; operator: string; value: any }): string {
  if (f.operator === "IS NOT" && f.value === "NULL") return `"${f.column}" IS NOT NULL`;
  // PostgREST `.is(col, null)` — the only way to express IS NULL, since
  // `eq.null` is a literal comparison and never true.
  if (f.operator === "IS" && f.value === null) return `"${f.column}" IS NULL`;
  if (f.operator === "IN") {
    const values = (f.value as any[]) ?? [];
    // Defensive only: `SupabaseTabularStorage` short-circuits an empty in-list
    // before it reaches `.in()`, precisely so nothing depends on how PostgREST
    // renders `in.()`. Kept so a direct `.in(col, [])` here can't emit `IN ()`.
    if (values.length === 0) return "1=0";
    return `"${f.column}" IN (${values.map(mockSqlLiteral).join(", ")})`;
  }
  if (f.operator === "NOT IN") {
    const values = (f.value as any[]) ?? [];
    // The inverse of the empty IN above: excluding nothing excludes nothing.
    // `SupabaseTabularStorage` renders an empty exclusion as an `.or()`
    // tautology rather than reaching here, so this is defensive too.
    if (values.length === 0) return "1=1";
    return `"${f.column}" NOT IN (${values.map(mockSqlLiteral).join(", ")})`;
  }
  return `"${f.column}" ${f.operator} ${mockSqlLiteral(f.value)}`;
}

/**
 * Parses a PostgREST list literal — `("a","b",3,null)` — back into values.
 *
 * The inverse of the encoding `SupabaseTabularStorage` writes for
 * `.not(col, "in", …)`: strings arrive double-quoted with backslash escapes and
 * everything else bare, which is how PostgREST spells numbers, booleans and
 * NULL. A bare token that is none of those stays a string.
 */
function parsePostgrestList(literal: string): any[] {
  const body = literal.trim().replace(/^\(/, "").replace(/\)$/, "");
  if (body.trim().length === 0) return [];
  const out: any[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '"') {
      i++;
      let buf = "";
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") {
          i++;
          buf += body[i] ?? "";
          i++;
          continue;
        }
        buf += body[i];
        i++;
      }
      i++; // closing quote
      out.push(buf);
      while (i < body.length && body[i] !== ",") i++;
      i++; // comma
      continue;
    }
    let buf = "";
    while (i < body.length && body[i] !== ",") {
      buf += body[i];
      i++;
    }
    i++; // comma
    const token = buf.trim();
    if (token === "null") out.push(null);
    else if (token === "true") out.push(true);
    else if (token === "false") out.push(false);
    else if (token !== "" && !Number.isNaN(Number(token))) out.push(Number(token));
    else out.push(token);
  }
  return out;
}

/**
 * Accumulates a `.not(column, operator, value)` call as a filter.
 *
 * Shared by the select, update and delete builders, which each carried a copy
 * that handled `is null` and silently DROPPED everything else — so an
 * unsupported negation returned every row instead of failing, which reads as a
 * broken production filter rather than a gap in the mock. That is why an
 * unsupported spelling throws here.
 */
function mockPushNotFilter(
  filters: Array<{ column: string; operator: string; value: any }>,
  column: string,
  operator: string,
  value: any
): void {
  if (operator === "is" && value === null) {
    filters.push({ column, operator: "IS NOT", value: "NULL" });
    return;
  }
  if (operator === "in") {
    filters.push({ column, operator: "NOT IN", value: parsePostgrestList(String(value)) });
    return;
  }
  throw new Error(`Unsupported PostgREST not.${operator} in mock`);
}

/**
 * Accumulates a `.like(column, pattern)` call the way PostgREST reads it:
 * every `*` in the value becomes `%` before PostgreSQL sees it, and no ESCAPE
 * clause is added, so the backslash is the escape character by default.
 */
function mockPushLikeFilter(
  filters: Array<{ column: string; operator: string; value: any }>,
  column: string,
  pattern: string
): void {
  filters.push({ column, operator: "LIKE", value: pattern.replace(/\*/g, "%") });
}

/**
 * Accumulates a generic `.filter(column, operator, value)` call. Only `match`
 * (PostgreSQL's `~`) is used by the storage; anything else throws rather than
 * being dropped, for the reason given on {@link mockPushNotFilter}.
 */
function mockPushGenericFilter(
  filters: Array<{ column: string; operator: string; value: any }>,
  column: string,
  operator: string,
  value: any
): void {
  if (operator === "match") {
    filters.push({ column, operator: "~", value: String(value) });
    return;
  }
  throw new Error(`Unsupported PostgREST filter operator ${operator} in mock`);
}

/**
 * The WHERE body for the accumulated filters, or `undefined` when there are
 * none. Shared by select, update and delete so an `.or()` group cannot be
 * honoured on one path and dropped on another — it used to be folded in only
 * by `executeQuery`, which made an `.or()` on a DELETE silently unfiltered.
 */
function mockWhereClause(qb: {
  _filters: Array<{ column: string; operator: string; value: any }>;
  _orFilters: string[];
}): string | undefined {
  const parts: string[] = [];
  if (qb._filters.length > 0) parts.push(qb._filters.map(mockRenderFilter).join(" AND "));
  for (const orFilter of qb._orFilters) parts.push(`(${translatePostgrestFilter(orFilter)})`);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

export function createSupabaseMockClient(): IClosableSupabaseClient {
  const pglite = new PGlite({ extensions: { vector } });
  const logger = getTestingLogger();
  setLogger(logger);

  // Create a minimal SupabaseClient-compatible object
  const mockClient = {
    // Remove a realtime channel (cleanup)
    removeChannel: (_channel: any) => {
      // Mock removeChannel - no-op
    },

    // Realtime channel method for subscriptions
    channel: (name: string) => {
      return {
        on: (event: string, filter: any, callback: any) => {
          // Mock realtime subscription - do nothing, just return self for chaining
          return {
            on: (event: string, filter: any, callback: any) => {
              return {
                subscribe: (callback?: any) => {
                  // Mock subscribe - call callback immediately with "SUBSCRIBED" status
                  if (callback) {
                    callback("SUBSCRIBED");
                  }
                  return { unsubscribe: () => {} };
                },
              };
            },
            subscribe: (callback?: any) => {
              // Mock subscribe - call callback immediately with "SUBSCRIBED" status
              if (callback) {
                callback("SUBSCRIBED");
              }
              return { unsubscribe: () => {} };
            },
          };
        },
        subscribe: (callback?: any) => {
          // Mock subscribe - call callback immediately with "SUBSCRIBED" status
          if (callback) {
            callback("SUBSCRIBED");
          }
          return { unsubscribe: () => {} };
        },
      };
    },

    // RPC method for executing raw SQL (used in setup and atomic operations)
    rpc: async (functionName: string, params?: Record<string, any>) => {
      if (functionName === "exec_sql" && params?.query) {
        try {
          const result = await pglite.query(params.query);
          // Return rows for queries with RETURNING clause, otherwise null
          return { data: result.rows.length > 0 ? result.rows : null, error: null };
        } catch (error: any) {
          // `pglite.query` runs a single prepared statement. Migration files
          // (and other setup SQL) bundle many statements; route those through
          // `pglite.exec`, which supports multi-statement scripts.
          if (error.message?.includes("cannot insert multiple commands")) {
            try {
              const results = await pglite.exec(params.query);
              const last = results[results.length - 1];
              return { data: last && last.rows.length > 0 ? last.rows : null, error: null };
            } catch (execError: any) {
              if (
                execError.message?.includes("already exists") ||
                execError.code === "42P07" ||
                execError.code === "42710" ||
                execError.code === "42P06"
              ) {
                return { data: null, error: null };
              }
              return { data: null, error: execError };
            }
          }
          // Ignore "already exists" errors for tables, types, and indexes
          if (
            error.message?.includes("already exists") ||
            error.code === "42P07" || // relation already exists
            error.code === "42710" || // type already exists
            error.code === "42P06" // schema already exists
          ) {
            return { data: null, error: null };
          }

          // For enum types that don't exist, try to handle gracefully
          if (error.message?.includes("type") && error.message?.includes("does not exist")) {
            logger.info(`Type creation issue: ${error.message}`);
            return { data: null, error: null };
          }

          return { data: null, error };
        }
      }

      // Handle calling arbitrary PostgreSQL functions positionally. PostgREST
      // resolves named arguments, but the mock maps the params object's values
      // to `$1, $2, ...` in insertion order — so callers MUST pass rpc params
      // in the SQL function's parameter order.
      const values = params ? Object.values(params) : [];
      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      try {
        const result = await pglite.query(
          `SELECT * FROM "${functionName.replace(/"/g, '""')}"(${placeholders})`,
          values
        );
        return { data: result.rows, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e?.message ?? String(e) } };
      }
    },

    // From method for table operations
    from: (table: string) => {
      const queryBuilder = {
        _table: table,
        _select: "*",
        _filters: [] as Array<{ column: string; operator: string; value: any }>,
        _limit: undefined as number | undefined,
        _offset: undefined as number | undefined,
        _order: [] as Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>,
        _orFilters: [] as string[],
        _single: false,

        select: (columns = "*") => {
          queryBuilder._select = columns;
          return queryBuilder;
        },

        insert: (data: any) => {
          const executeInsert = async () => {
            try {
              const isArray = Array.isArray(data);
              const records = isArray ? data : [data];

              if (records.length === 0) {
                return { data: null, error: new Error("No data to insert") };
              }

              const keys = Object.keys(records[0]);
              const values = records
                .map(
                  (record) =>
                    `(${keys
                      .map((k) => {
                        const val = record[k];
                        if (val === null || val === undefined) return "NULL";
                        if (typeof val === "object")
                          return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
                        if (typeof val === "string") return `'${val.replace(/'/g, "''")}'`;
                        return String(val);
                      })
                      .join(",")})`
                )
                .join(",");

              const query = `INSERT INTO "${queryBuilder._table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES ${values} RETURNING *`;
              const result = await pglite.query(query);

              return { data: result.rows[0], error: null };
            } catch (error: any) {
              return { data: null, error };
            }
          };

          return {
            select: () => {
              return {
                single: async () => {
                  return executeInsert();
                },
              };
            },
            then: async (resolve: any, reject: any) => {
              try {
                const result = await executeInsert();
                resolve(result);
              } catch (error) {
                reject?.(error);
              }
            },
          };
        },

        upsert: (data: any, options?: { onConflict?: string }) => {
          const executeUpsert = async () => {
            try {
              const isArray = Array.isArray(data);
              const records = isArray ? data : [data];

              if (records.length === 0) {
                return { data: [], error: null };
              }

              const keys = Object.keys(records[0]);

              // Use parameterized queries for better type handling (especially arrays)
              const params: any[] = [];
              let paramIndex = 1;

              const values = records
                .map(
                  (record) =>
                    `(${keys
                      .map((k) => {
                        const val = record[k];
                        if (val === null || val === undefined) {
                          return "NULL";
                        }
                        // Use parameterized query for proper type handling
                        params.push(val);
                        const currentIndex = paramIndex++;
                        return `$${currentIndex}`;
                      })
                      .join(",")})`
                )
                .join(",");

              let query = `INSERT INTO "${queryBuilder._table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES ${values}`;

              if (options?.onConflict) {
                const updateSet = keys
                  .filter((k) => !options.onConflict?.includes(k))
                  .map((k) => `"${k}" = EXCLUDED."${k}"`)
                  .join(", ");
                // Quote each conflict-target column so a camelCase PK (e.g.
                // "refKey") is not folded to lowercase; real PostgREST quotes
                // identifiers, and the INSERT column list / SET clause above
                // already do.
                const conflictCols = options.onConflict
                  .split(",")
                  .map((c: string) => `"${c.trim()}"`)
                  .join(",");
                query += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`;
              }

              query += " RETURNING *";

              const result = await pglite.query(query, params);
              return { data: result.rows, error: null };
            } catch (error: any) {
              return { data: null, error };
            }
          };

          return {
            select: () => {
              return {
                single: async () => {
                  const result = await executeUpsert();
                  if (result.error) return result;
                  // Return single record or first record from array
                  const singleData = Array.isArray(result.data) ? result.data[0] : result.data;
                  return { data: singleData, error: null };
                },
                then: async (resolve: any, reject: any) => {
                  try {
                    const result = await executeUpsert();
                    resolve(result);
                  } catch (error) {
                    reject?.(error);
                  }
                },
              };
            },
            then: async (resolve: any, reject: any) => {
              try {
                const result = await executeUpsert();
                resolve(result);
              } catch (error) {
                reject?.(error);
              }
            },
          };
        },

        update: (data: any) => {
          // Shared SET/WHERE builder for the `.select().single()/.maybeSingle()`
          // (RETURNING *) and bare-`await` (no RETURNING) forms below, mirroring
          // `executeDelete`/`executeQuery`'s single-source-of-truth pattern.
          const buildSetClause = (): string =>
            Object.entries(data)
              .map(([k, v]) => {
                if (v === null || v === undefined) return `"${k}" = NULL`;
                if (typeof v === "object")
                  return `"${k}" = '${JSON.stringify(v).replace(/'/g, "''")}'`;
                if (typeof v === "string") return `"${k}" = '${v.replace(/'/g, "''")}'`;
                return `"${k}" = ${asText(v)}`;
              })
              .join(", ");

          const buildWhereClause = (): string => mockWhereClause(queryBuilder) ?? "1=1";

          // Only rows matching every accumulated filter are updated, mirroring
          // PostgREST's `UPDATE ... WHERE <eq/lt/lte/gt/gte AND ...>` semantics.
          const executeUpdateReturning = async () => {
            try {
              const query = `UPDATE "${queryBuilder._table}" SET ${buildSetClause()} WHERE ${buildWhereClause()} RETURNING *`;
              const result = await pglite.query(query);
              return { data: result.rows[0] || null, error: null };
            } catch (error: any) {
              return { data: null, error };
            }
          };

          const updateBuilder = {
            eq: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "=", value });
              return updateBuilder; // Return self for chaining
            },
            is: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "IS", value: null });
              return updateBuilder;
            },
            or: (filter: string) => {
              queryBuilder._orFilters.push(filter);
              return updateBuilder;
            },
            not: (column: string, operator: string, value: any) => {
              mockPushNotFilter(queryBuilder._filters, column, operator, value);
              return updateBuilder;
            },
            neq: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "!=", value });
              return updateBuilder;
            },
            in: (column: string, values: any[]) => {
              queryBuilder._filters.push({ column, operator: "IN", value: values });
              return updateBuilder;
            },
            like: (column: string, pattern: string) => {
              mockPushLikeFilter(queryBuilder._filters, column, pattern);
              return updateBuilder;
            },
            filter: (column: string, operator: string, value: any) => {
              mockPushGenericFilter(queryBuilder._filters, column, operator, value);
              return updateBuilder;
            },
            lt: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "<", value });
              return updateBuilder;
            },
            lte: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "<=", value });
              return updateBuilder;
            },
            gt: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: ">", value });
              return updateBuilder;
            },
            gte: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: ">=", value });
              return updateBuilder;
            },

            select: () => {
              return {
                // `single()` errors when zero rows match (real PostgREST/postgrest-js
                // behavior); `maybeSingle()` returns `data: null, error: null` instead
                // — this is what `updateWhere`'s CAS semantics rely on.
                single: async () => {
                  const result = await executeUpdateReturning();
                  if (result.error) return result;
                  if (!result.data) {
                    return { data: null, error: { code: "PGRST116", message: "No rows found" } };
                  }
                  return result;
                },
                maybeSingle: async () => executeUpdateReturning(),
              };
            },
            then: async (resolve: any, reject: any) => {
              try {
                const query = `UPDATE "${queryBuilder._table}" SET ${buildSetClause()} WHERE ${buildWhereClause()}`;
                await pglite.query(query);

                resolve?.({ data: null, error: null });
              } catch (error: any) {
                reject?.(error);
              }
            },
          };

          return updateBuilder;
        },

        delete: () => {
          return {
            eq: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "=", value });
              return deleteBuilder;
            },
            is: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "IS", value: null });
              return deleteBuilder;
            },
            in: (column: string, values: any[]) => {
              queryBuilder._filters.push({ column, operator: "IN", value: values });
              return deleteBuilder;
            },
            like: (column: string, pattern: string) => {
              mockPushLikeFilter(queryBuilder._filters, column, pattern);
              return deleteBuilder;
            },
            filter: (column: string, operator: string, value: any) => {
              mockPushGenericFilter(queryBuilder._filters, column, operator, value);
              return deleteBuilder;
            },
            neq: (column: string, value: any) => {
              // `neq.null` means IS DISTINCT FROM NULL in PostgREST (used by
              // `deleteAll`'s always-true `.neq(pk, null)`); match the select
              // chain so a raw `!= NULL` doesn't silently delete nothing.
              if (value === null) {
                queryBuilder._filters.push({ column, operator: "IS NOT", value: "NULL" });
              } else {
                queryBuilder._filters.push({ column, operator: "!=", value });
              }
              return deleteBuilder;
            },
            lt: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "<", value });
              return deleteBuilder;
            },
            lte: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: "<=", value });
              return deleteBuilder;
            },
            gt: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: ">", value });
              return deleteBuilder;
            },
            gte: (column: string, value: any) => {
              queryBuilder._filters.push({ column, operator: ">=", value });
              return deleteBuilder;
            },
            or: (filter: string) => {
              queryBuilder._orFilters.push(filter);
              return deleteBuilder;
            },
            not: (column: string, operator: string, value: any) => {
              mockPushNotFilter(queryBuilder._filters, column, operator, value);
              return deleteBuilder;
            },
            then: async (resolve: any, reject: any) => {
              try {
                const result = await executeDelete();
                resolve(result);
              } catch (error) {
                reject?.(error);
              }
            },
          };
        },

        eq: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "=", value });
          return queryBuilder;
        },
        is: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "IS", value: null });
          return queryBuilder;
        },
        not: (column: string, operator: string, value: any) => {
          mockPushNotFilter(queryBuilder._filters, column, operator, value);
          return queryBuilder;
        },
        in: (column: string, values: any[]) => {
          queryBuilder._filters.push({ column, operator: "IN", value: values });
          return queryBuilder;
        },
        like: (column: string, pattern: string) => {
          mockPushLikeFilter(queryBuilder._filters, column, pattern);
          return queryBuilder;
        },
        filter: (column: string, operator: string, value: any) => {
          mockPushGenericFilter(queryBuilder._filters, column, operator, value);
          return queryBuilder;
        },

        neq: (column: string, value: any) => {
          if (value === null) {
            queryBuilder._filters.push({ column, operator: "IS NOT", value: "NULL" });
          } else {
            queryBuilder._filters.push({ column, operator: "!=", value });
          }
          return queryBuilder;
        },

        lt: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "<", value });
          return queryBuilder;
        },

        lte: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "<=", value });
          return queryBuilder;
        },

        gt: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: ">", value });
          return queryBuilder;
        },

        gte: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: ">=", value });
          return queryBuilder;
        },

        order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
          queryBuilder._order.push({
            column,
            ascending: options?.ascending ?? true,
            nullsFirst: options?.nullsFirst,
          });
          return queryBuilder;
        },

        or: (filter: string) => {
          queryBuilder._orFilters.push(filter);
          return queryBuilder;
        },

        limit: (count: number) => {
          queryBuilder._limit = count;
          return queryBuilder;
        },

        range: (start: number, end: number) => {
          queryBuilder._offset = start;
          queryBuilder._limit = end - start + 1;
          return queryBuilder;
        },

        single: async () => {
          queryBuilder._single = true;
          queryBuilder._limit = 1;
          const result = await executeQuery();

          if (result.error) {
            return result;
          }

          if (!result.data || result.data.length === 0) {
            return {
              data: null,
              error: { code: "PGRST116", message: "No rows found" },
            };
          }

          return { data: result.data[0], error: null };
        },
      };

      const executeDelete = async () => {
        try {
          let query = `DELETE FROM "${queryBuilder._table}"`;

          const whereClause = mockWhereClause(queryBuilder);
          if (whereClause !== undefined) {
            query += ` WHERE ${whereClause}`;
          }

          await pglite.query(query);
          return { data: null, error: null };
        } catch (error: any) {
          return { data: null, error };
        }
      };

      const deleteBuilder = {
        eq: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "=", value });
          return deleteBuilder;
        },
        is: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "IS", value: null });
          return deleteBuilder;
        },
        in: (column: string, values: any[]) => {
          queryBuilder._filters.push({ column, operator: "IN", value: values });
          return deleteBuilder;
        },
        like: (column: string, pattern: string) => {
          mockPushLikeFilter(queryBuilder._filters, column, pattern);
          return deleteBuilder;
        },
        filter: (column: string, operator: string, value: any) => {
          mockPushGenericFilter(queryBuilder._filters, column, operator, value);
          return deleteBuilder;
        },
        neq: (column: string, value: any) => {
          if (value === null) {
            queryBuilder._filters.push({ column, operator: "IS NOT", value: "NULL" });
          } else {
            queryBuilder._filters.push({ column, operator: "!=", value });
          }
          return deleteBuilder;
        },
        lt: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "<", value });
          return deleteBuilder;
        },
        lte: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: "<=", value });
          return deleteBuilder;
        },
        gt: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: ">", value });
          return deleteBuilder;
        },
        gte: (column: string, value: any) => {
          queryBuilder._filters.push({ column, operator: ">=", value });
          return deleteBuilder;
        },
        or: (filter: string) => {
          queryBuilder._orFilters.push(filter);
          return deleteBuilder;
        },
        not: (column: string, operator: string, value: any) => {
          mockPushNotFilter(queryBuilder._filters, column, operator, value);
          return deleteBuilder;
        },
        then: async (resolve: any, reject: any) => {
          try {
            const result = await executeDelete();
            resolve(result);
          } catch (error) {
            reject?.(error);
          }
        },
      };

      const executeQuery = async () => {
        try {
          let query = `SELECT ${queryBuilder._select} FROM "${queryBuilder._table}"`;

          const whereClause = mockWhereClause(queryBuilder);
          if (whereClause !== undefined) {
            query += ` WHERE ${whereClause}`;
          }

          if (queryBuilder._order.length > 0) {
            const orderParts = queryBuilder._order.map((o) => {
              const dir = o.ascending ? "ASC" : "DESC";
              const nulls =
                o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
              return `"${o.column}" ${dir}${nulls}`;
            });
            query += ` ORDER BY ${orderParts.join(", ")}`;
          }

          if (queryBuilder._offset !== undefined) {
            query += ` OFFSET ${queryBuilder._offset}`;
          }

          if (queryBuilder._limit !== undefined) {
            query += ` LIMIT ${queryBuilder._limit}`;
          }

          const result = await pglite.query(query);
          return { data: result.rows, error: null, count: result.rows.length };
        } catch (error: any) {
          return { data: null, error, count: null };
        }
      };

      // Add the missing then method to make it thenable
      return Object.assign(queryBuilder, {
        then: async (resolve: any, reject: any) => {
          try {
            const result = await executeQuery();
            resolve(result);
          } catch (error) {
            reject?.(error);
          }
        },
      });
    },

    close: async () => {
      await pglite.close();
    },
  };

  return mockClient as unknown as IClosableSupabaseClient;
}
