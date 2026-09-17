/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Sqlite, SqliteTabularStorage } from "@workglow/sqlite/storage";
import type { ITabularStorage } from "@workglow/storage";
import { InMemoryTabularStorage } from "@workglow/storage";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/schema";
import type { EvalConfig } from "./config";

/**
 * One pulled HuggingFace dataset split. `columns` and `label_names` are JSON
 * strings so the record round-trips through any tabular backend unchanged.
 */
export const DatasetMetaSchema = {
  type: "object",
  properties: {
    dataset: { type: "string" },
    split: { type: "string" },
    config: { type: "string" },
    num_rows: { type: "number" },
    columns: { type: "string" },
    label_names: { type: ["string", "null"] },
    source: { type: "string" },
    fetched_at: { type: "string" },
  },
  required: ["dataset", "split", "config", "num_rows", "columns", "source", "fetched_at"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const DatasetMetaPrimaryKeyNames = ["dataset", "split"] as const;

/** One dataset row, stored as the raw JSON object the dataset provides. */
export const DatasetRowSchema = {
  type: "object",
  properties: {
    dataset: { type: "string" },
    split: { type: "string" },
    row_index: { type: "number" },
    data: { type: "string" },
  },
  required: ["dataset", "split", "row_index", "data"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const DatasetRowPrimaryKeyNames = ["dataset", "split", "row_index"] as const;
export type DatasetRowRecord = FromSchema<typeof DatasetRowSchema>;

/** One eval sweep: a dataset split run through one workflow across N models. */
export const EvalRunSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", "x-auto-generated": true },
    kind: { type: "string" },
    dataset: { type: "string" },
    split: { type: "string" },
    models: { type: "string" },
    options: { type: "string" },
    created_at: { type: "string" },
  },
  required: ["run_id", "kind", "dataset", "split", "models", "options", "created_at"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const EvalRunPrimaryKeyNames = ["run_id"] as const;

/**
 * One workflow execution result: (run, model, dataset row) → prediction.
 * Classification-style evals fill `expected`/`predicted`; numeric evals fill
 * `expected_value`/`predicted_value`. Failed executions set `ok: 0` and `error`.
 */
export const EvalResultSchema = {
  type: "object",
  properties: {
    run_id: { type: "string" },
    model: { type: "string" },
    row_index: { type: "number" },
    ok: { type: "number" },
    error: { type: ["string", "null"] },
    expected: { type: ["string", "null"] },
    predicted: { type: ["string", "null"] },
    expected_value: { type: ["number", "null"] },
    predicted_value: { type: ["number", "null"] },
    latency_ms: { type: "number" },
    input_tokens: { type: ["integer", "null"] },
    output_tokens: { type: ["integer", "null"] },
    cached_tokens: { type: ["integer", "null"] },
    cache_write_tokens: { type: ["integer", "null"] },
    image_input_tokens: { type: ["integer", "null"] },
    image_cached_tokens: { type: ["integer", "null"] },
    total_tokens: { type: ["integer", "null"] },
    cost: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
  },
  required: ["run_id", "model", "row_index", "ok", "latency_ms"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const EvalResultPrimaryKeyNames = ["run_id", "model", "row_index"] as const;
export type EvalResultRecord = FromSchema<typeof EvalResultSchema>;

export interface EvalStores {
  readonly datasets: ITabularStorage<typeof DatasetMetaSchema, typeof DatasetMetaPrimaryKeyNames>;
  readonly rows: ITabularStorage<typeof DatasetRowSchema, typeof DatasetRowPrimaryKeyNames>;
  readonly runs: ITabularStorage<typeof EvalRunSchema, typeof EvalRunPrimaryKeyNames>;
  readonly results: ITabularStorage<typeof EvalResultSchema, typeof EvalResultPrimaryKeyNames>;
}

/** Opens (creating on first use) the SQLite-backed eval stores. */
export async function createSqliteStores(config: EvalConfig): Promise<EvalStores> {
  await Sqlite.init();
  const db = new Sqlite.Database(config.dbPath);
  const stores: EvalStores = {
    datasets: new SqliteTabularStorage(
      db,
      "eval_dataset",
      DatasetMetaSchema,
      DatasetMetaPrimaryKeyNames
    ),
    rows: new SqliteTabularStorage(
      db,
      "eval_dataset_row",
      DatasetRowSchema,
      DatasetRowPrimaryKeyNames
    ),
    runs: new SqliteTabularStorage(db, "eval_run", EvalRunSchema, EvalRunPrimaryKeyNames),
    results: new SqliteTabularStorage(
      db,
      "eval_result",
      EvalResultSchema,
      EvalResultPrimaryKeyNames
    ),
  };
  await setupStores(stores);
  return stores;
}

/** In-memory stores with the same shape; used by the unit tests. */
export async function createInMemoryStores(): Promise<EvalStores> {
  const stores: EvalStores = {
    datasets: new InMemoryTabularStorage(DatasetMetaSchema, DatasetMetaPrimaryKeyNames),
    rows: new InMemoryTabularStorage(DatasetRowSchema, DatasetRowPrimaryKeyNames),
    runs: new InMemoryTabularStorage(EvalRunSchema, EvalRunPrimaryKeyNames),
    results: new InMemoryTabularStorage(EvalResultSchema, EvalResultPrimaryKeyNames),
  };
  await setupStores(stores);
  return stores;
}

async function setupStores(stores: EvalStores): Promise<void> {
  await stores.datasets.setupDatabase();
  await stores.rows.setupDatabase();
  await stores.runs.setupDatabase();
  await stores.results.setupDatabase();
}
