/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig, ModelPricing } from "@workglow/ai";
import { estimateCost } from "@workglow/ai";
import type { IExecuteContext, StreamEvent, Usage } from "@workglow/task-graph";
import type { DatasetRow } from "../hf/types";
import type { EvalKind } from "../models";
import { ensureEmbeddingDimensions, ensureModelDownloaded, resolveModelConfig } from "../models";
import type { DatasetRowRecord, EvalStores } from "../storage";
import { makeClassifyExecutor } from "./classify";
import { makeExtractExecutor } from "./extract";
import { makeSimilarityExecutor } from "./similarity";
import type { ColumnOptions, DatasetContext, RowExecutor } from "./types";

export interface SweepOptions {
  readonly kind: EvalKind;
  readonly dataset: string;
  readonly split: string;
  readonly models: readonly string[];
  readonly columns: ColumnOptions;
  readonly context: DatasetContext;
  readonly onProgress?:
    | ((done: number, total: number, model: string, ok: boolean, usage: Usage | undefined) => void)
    | undefined;
  /**
   * Forwarded to each row's executor as its stream-chunk listener. Left
   * undefined for an ordinary sweep, so nothing subscribes and a 500-row run
   * pays nothing for it.
   */
  readonly onStreamChunk?: ((event: StreamEvent) => void) | undefined;
  /**
   * The sweep task's own context. Given one, each row's workflow is owned for
   * its duration, so the run is a single task graph the progress surfaces can
   * see into rather than a loop of invisible standalone runs.
   */
  readonly owner?: IExecuteContext | undefined;
}

/**
 * Map one run's token accounting onto the result row's columns.
 *
 * An unreported counter is stored as `null`, never `0` — the database has to
 * keep the distinction the in-memory type protects, or a model that never
 * mentions caching becomes indistinguishable from one that cached nothing.
 *
 * `at` is when the request ran, which is what a time-of-day rate is charged
 * against. A batch that straddles the boundary of one must not have its rows
 * priced by whenever the sweep happened to reach the write.
 */
export function usageColumns(
  usage: Usage | undefined,
  pricing: ModelPricing | undefined,
  at: Date | undefined
): {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  image_input_tokens: number | null;
  image_cached_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  currency: string | null;
} {
  const estimate = usage ? estimateCost(usage, pricing, { at }) : undefined;
  return {
    input_tokens: usage?.input ?? null,
    output_tokens: usage?.output ?? null,
    cached_tokens: usage?.cached ?? null,
    cache_write_tokens: usage?.cacheWrite ?? null,
    // The image buckets are disjoint from `input`, so a row without them
    // states a prompt smaller than the `cost` beside it was charged for.
    image_input_tokens: usage?.imageInput ?? null,
    image_cached_tokens: usage?.imageCached ?? null,
    total_tokens: usage?.total ?? null,
    cost: estimate?.amount ?? null,
    currency: estimate?.currency ?? null,
  };
}

const EXECUTORS: Record<
  EvalKind,
  (model: ModelConfig, columns: ColumnOptions, context: DatasetContext) => RowExecutor
> = {
  classify: makeClassifyExecutor,
  similarity: makeSimilarityExecutor,
  extract: makeExtractExecutor,
};

function makeExecutor(
  kind: EvalKind,
  model: ModelConfig,
  columns: ColumnOptions,
  context: DatasetContext
): RowExecutor {
  return EXECUTORS[kind](model, columns, context);
}

/**
 * Run every stored dataset row through the eval workflow for each model,
 * persisting one result row per (run, model, dataset row). Failures are
 * recorded (`ok: 0` + error) rather than aborting the sweep, so one bad model
 * or one bad row never loses the rest of the run.
 */
export async function runSweep(
  stores: EvalStores,
  rows: readonly DatasetRowRecord[],
  options: SweepOptions
): Promise<string> {
  const run = await stores.runs.put({
    kind: options.kind,
    dataset: options.dataset,
    split: options.split,
    models: JSON.stringify(options.models),
    options: JSON.stringify(options.columns),
    created_at: new Date().toISOString(),
  });

  // Rows are model-independent: parse each once for the whole sweep, and turn
  // an unparseable row into a per-row failure instead of aborting.
  const parsedRows = rows.map((record) => {
    try {
      return { record, row: JSON.parse(record.data) as DatasetRow, parseError: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { record, row: undefined, parseError: `invalid stored row: ${message}` };
    }
  });

  const total = rows.length * options.models.length;
  let done = 0;

  for (const modelId of options.models) {
    let executor: RowExecutor | undefined;
    let setupError: string | undefined;
    let modelPricing: ModelPricing | undefined;
    try {
      let config = resolveModelConfig(modelId, options.kind);
      if (options.kind === "similarity") config = await ensureEmbeddingDimensions(config);
      await ensureModelDownloaded(config);
      modelPricing = config.pricing;
      executor = makeExecutor(options.kind, config, options.columns, options.context);
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }

    for (const { record, row, parseError } of parsedRows) {
      const t0 = performance.now();
      const requestedAt = new Date();
      let outcome: SweepOutcome;
      let outcomeUsage: Usage | undefined;
      if (!executor) {
        outcome = failedOutcome(setupError ?? "executor unavailable");
      } else if (!row) {
        outcome = failedOutcome(parseError ?? "invalid stored row");
      } else {
        try {
          const prediction = await executor(
            row,
            options.onStreamChunk,
            options.owner
              ? { context: options.owner, title: `${modelId} · row ${record.row_index}` }
              : undefined
          );
          outcomeUsage = prediction.usage;
          outcome = {
            ok: 1,
            error: null,
            expected: prediction.expected ?? null,
            predicted: prediction.predicted ?? null,
            expected_value: prediction.expectedValue ?? null,
            predicted_value: prediction.predictedValue ?? null,
          };
        } catch (err) {
          outcome = failedOutcome(err instanceof Error ? err.message : String(err));
        }
      }
      const latency = performance.now() - t0;
      await stores.results.put({
        run_id: run.run_id,
        model: modelId,
        row_index: record.row_index,
        latency_ms: Math.round(latency * 100) / 100,
        ...usageColumns(outcomeUsage, modelPricing, requestedAt),
        ...outcome,
      });
      done++;
      options.onProgress?.(done, total, modelId, outcome.ok === 1, outcomeUsage);
    }
  }

  return run.run_id;
}

interface SweepOutcome {
  readonly ok: number;
  readonly error: string | null;
  readonly expected: string | null;
  readonly predicted: string | null;
  readonly expected_value: number | null;
  readonly predicted_value: number | null;
}

function failedOutcome(error: string): SweepOutcome {
  return {
    ok: 0,
    error,
    expected: null,
    predicted: null,
    expected_value: null,
    predicted_value: null,
  };
}
