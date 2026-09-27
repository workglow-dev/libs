/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrefixColumn } from "@workglow/job-queue";
import {
  buildPrefixColumnsSql,
  getPrefixColumnNames,
  getPrefixIndexPrefix,
  getPrefixIndexSuffix,
  type IMigration,
  PostgresDialect,
} from "@workglow/storage";
import type { Pool } from "../storage/_postgres/node-bun";

/** Options that change the rate-limiter tables' storage, not their shape. */
export interface PostgresRateLimiterTableOptions {
  /**
   * Keep both tables UNLOGGED: not written to the WAL, and emptied by crash
   * recovery. A limiter's rows are only a sliding window of recent starts and
   * the next permitted start, so losing them costs one window of pacing, while
   * logging them costs WAL on every reservation — the busiest writes a
   * fetch-heavy deployment makes. Opt-in; once applied it stays applied, since
   * nothing in the migration history turns it back.
   */
  readonly unlogged?: boolean;
}

/** Migration set for the Postgres rate-limiter tables. */
export function postgresRateLimiterMigrations(
  executionTableName: string,
  nextAvailableTableName: string,
  prefixes: readonly PrefixColumn[],
  tableOptions: PostgresRateLimiterTableOptions = {}
): IMigration<Pool>[] {
  const component = `rate-limiter:postgres:${executionTableName}`;
  const prefixColumnsSql = buildPrefixColumnsSql(PostgresDialect, prefixes);
  const prefixColumnNames = getPrefixColumnNames(prefixes);
  const prefixIndexPrefix = getPrefixIndexPrefix(prefixes);
  const indexSuffix = getPrefixIndexSuffix(prefixes);
  const primaryKeyColumns =
    prefixColumnNames.length > 0 ? `${prefixColumnNames.join(", ")}, queue_name` : "queue_name";

  const migrations: IMigration<Pool>[] = [
    {
      component,
      version: 1,
      description: "Create rate-limiter execution + next_available tables",
      async up(db: Pool) {
        await db.query(`
          CREATE TABLE IF NOT EXISTS ${executionTableName} (
            id SERIAL PRIMARY KEY,
            ${prefixColumnsSql}queue_name TEXT NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          )
        `);
        await db.query(`
          CREATE INDEX IF NOT EXISTS rate_limit_exec_queue${indexSuffix}_idx
            ON ${executionTableName} (${prefixIndexPrefix}queue_name, executed_at)
        `);
        await db.query(`
          CREATE TABLE IF NOT EXISTS ${nextAvailableTableName} (
            ${prefixColumnsSql}queue_name TEXT NOT NULL,
            next_available_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (${primaryKeyColumns})
          )
        `);
      },
    },
  ];
  if (tableOptions.unlogged === true) {
    migrations.push({
      component,
      version: 2,
      description: "Keep the rate-limiter tables UNLOGGED",
      async up(db: Pool) {
        // Idempotent: SET UNLOGGED on an unlogged table is a no-op.
        await db.query(`ALTER TABLE ${executionTableName} SET UNLOGGED`);
        await db.query(`ALTER TABLE ${nextAvailableTableName} SET UNLOGGED`);
      },
    });
  }
  return migrations;
}
