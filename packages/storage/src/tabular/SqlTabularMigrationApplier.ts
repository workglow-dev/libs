/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { JsonSchema } from "@workglow/util/schema";
import {
  type ITabularMigrationApplier,
  type TabularMigrationOp,
  MIGRATIONS_TABLE,
  runBackfill,
} from "../migrations";
import { type AnyTabularStorage } from "./ITabularStorage";
import {
  buildAddColumnSql,
  buildAddIndexSql,
  buildDropColumnSql,
  buildDropIndexSql,
  buildRenameColumnSql,
} from "./sqlMigrationDdl";

/**
 * SQL-flavored {@link ITabularMigrationApplier}. Subclasses (one per dialect)
 * provide the connection-level primitives (`exec`, `tableExists`,
 * `withTransaction`) and the JSON-Schema-to-SQL mapper. The applier handles
 * op translation, atomicity, and bookkeeping.
 *
 * `applyMigration` runs all ops + the bookkeeping INSERT inside a single
 * `withTransaction` so DDL, backfill writes, and applied-version recording
 * commit (or roll back) together on backends that support real transactions.
 */
export abstract class SqlTabularMigrationApplier implements ITabularMigrationApplier {
  protected abstract dialectName(): "sqlite" | "postgres";
  protected abstract table(): string;
  protected abstract storage(): AnyTabularStorage;
  protected abstract mapTypeToSQL(typeDef: JsonSchema): string;
  protected abstract isNullableSchema(typeDef: JsonSchema): boolean;
  protected abstract executeSql(sql: string): Promise<void>;
  protected abstract executeSqlTx(sql: string, tx: AnyTabularStorage): Promise<void>;
  protected abstract recordAppliedTx(
    component: string,
    version: number,
    description: string | undefined,
    tx: AnyTabularStorage
  ): Promise<void>;
  protected abstract recordApplied(
    component: string,
    version: number,
    description: string | undefined
  ): Promise<void>;
  protected abstract queryAppliedVersions(component: string): Promise<Set<number>>;
  protected abstract probeTableExists(): Promise<boolean>;

  async ensureBookkeeping(): Promise<void> {
    await this.executeSql(this.bookkeepingDdl());
  }

  async appliedVersions(component: string): Promise<Set<number>> {
    return this.queryAppliedVersions(component);
  }

  async tableExists(): Promise<boolean> {
    return this.probeTableExists();
  }

  async markAllApplied(
    component: string,
    versions: ReadonlyArray<{ version: number; description: string | undefined }>
  ): Promise<void> {
    if (versions.length === 0) return;
    for (const v of versions) {
      await this.recordApplied(component, v.version, v.description);
    }
  }

  async applyMigration(
    component: string,
    version: number,
    description: string | undefined,
    ops: ReadonlyArray<TabularMigrationOp>,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const storage = this.storage();
    await storage.withTransaction(async (tx) => {
      let processed = 0;
      const total = Math.max(ops.length, 1);
      for (const op of ops) {
        await this.applyOp(op, tx);
        processed++;
        onProgress?.(processed / total);
      }
      await this.recordAppliedTx(component, version, description, tx);
    });
  }

  protected async applyOp(op: TabularMigrationOp, tx: AnyTabularStorage): Promise<void> {
    switch (op.kind) {
      case "addColumn": {
        const sqlType = this.mapTypeToSQL(op.schema);
        const nullable = this.isNullableSchema(op.schema);
        const hasDefault = op.default !== undefined;
        const sql = buildAddColumnSql(
          this.dialectName(),
          this.table(),
          op.name,
          sqlType,
          nullable,
          hasDefault,
          hasDefault ? this.defaultLiteralSql(op.default!, sqlType) : undefined
        );
        await this.executeSqlTx(sql, tx);
        return;
      }
      case "dropColumn": {
        await this.executeSqlTx(buildDropColumnSql(this.dialectName(), this.table(), op.name), tx);
        return;
      }
      case "renameColumn": {
        await this.executeSqlTx(
          buildRenameColumnSql(this.dialectName(), this.table(), op.from, op.to),
          tx
        );
        return;
      }
      case "addIndex": {
        await this.executeSqlTx(
          buildAddIndexSql(
            this.dialectName(),
            this.table(),
            op.name,
            op.columns,
            op.unique ?? false
          ),
          tx
        );
        return;
      }
      case "dropIndex": {
        await this.executeSqlTx(buildDropIndexSql(this.dialectName(), op.name), tx);
        return;
      }
      case "backfill": {
        await runBackfill(tx, op.batchSize ?? 500, op.transform);
        return;
      }
    }
  }

  /**
   * Renders a JS literal as SQL. Strings are quoted with `'` doubling;
   * numbers / booleans / null are rendered raw. NaN / ±Infinity throw
   * rather than silently splicing as `"NaN"` / `"Infinity"` (neither is
   * valid SQL).
   *
   * Arrays render as the dialect's own array literal, because a column whose
   * type IS an array needs an array default and `[]` is the common one — a
   * list column added to a populated table cannot be NOT NULL without it.
   * Everything else throws: a default must be a primitive or a list of them.
   */
  protected literalSql(value: unknown): string {
    if (Array.isArray(value)) return this.arrayLiteralSql(value, undefined);
    if (value === null) return "NULL";
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          `Unsupported numeric default for tabular migration: ${value} (must be finite)`
        );
      }
      return String(value);
    }
    if (typeof value === "boolean") {
      return this.dialectName() === "sqlite" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
    }
    throw new Error(
      `Unsupported default value for tabular migration: ${typeof value} (${asText(value)})`
    );
  }

  /**
   * An array default, in the dialect's own spelling.
   *
   * Postgres takes its array literal — `'{}'`, `'{"a","b"}'` — which the
   * server coerces to whatever array type the column was declared as, so one
   * rendering serves `text[]`, `integer[]` and the rest. Elsewhere the array
   * is JSON, which is how a dialect without a native array type stores one.
   *
   * Elements must be primitives: an array of objects is not a default any
   * dialect can express, and silently flattening one would put the wrong value
   * on every existing row.
   */
  /**
   * A default for a column whose SQL type is known.
   *
   * The type matters for arrays and only for arrays: the same `[]` is `'{}'`
   * in a native `text[]` and `'[]'` in a `jsonb`, and `'{}'` in a jsonb column
   * is an empty OBJECT — a silently wrong value on every existing row.
   * `mapPostgresType` chooses between the two by element type, so the caller
   * that mapped the column is the only one that knows which was picked.
   */
  protected defaultLiteralSql(value: unknown, sqlType: string): string {
    if (Array.isArray(value)) return this.arrayLiteralSql(value, sqlType);
    return this.literalSql(value);
  }

  protected arrayLiteralSql(value: readonly unknown[], sqlType: string | undefined): string {
    for (const item of value) {
      const kind = typeof item;
      if (item !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
        throw new Error(
          `Unsupported array default for tabular migration: element of type ${kind} (${asText(item)})`
        );
      }
    }
    const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;
    // A JSON column — which is where `mapPostgresType` sends an array whose
    // element type has no native Postgres array (a VARCHAR(n), an object) —
    // takes JSON, not an array literal.
    const isNativeArray = sqlType !== undefined && sqlType.trimEnd().endsWith("[]");
    if (this.dialectName() !== "postgres" || !isNativeArray) return quote(JSON.stringify(value));
    const elements = value.map((item) => {
      if (item === null) return "NULL";
      if (typeof item === "string") return `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      return String(item);
    });
    return quote(`{${elements.join(",")}}`);
  }

  /**
   * DDL for the bookkeeping table. Same shape used by the existing
   * per-driver runners.
   */
  protected bookkeepingDdl(): string {
    if (this.dialectName() === "sqlite") {
      return `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        component TEXT NOT NULL,
        version INTEGER NOT NULL,
        description TEXT,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (component, version)
      )`;
    }
    return `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT,
      applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (component, version)
    )`;
  }
}
