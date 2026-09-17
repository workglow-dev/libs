/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { getLogger } from "@workglow/util";
import type { GraphUsageAggregator } from "../task-graph/GraphUsageAggregator";
import type { RunUsagePrimaryKeyNames, RunUsageSchema } from "./RunUsageSchema";

export interface UsageRecorderOptions {
  readonly runId: string;
  /** Stamped on each row. Defaults to the wall clock at write time. */
  readonly now?: (() => string) | undefined;
}

type RunUsageStorage = ITabularStorage<typeof RunUsageSchema, typeof RunUsagePrimaryKeyNames>;

/**
 * Persist each finished task execution's token total.
 *
 * Subscribes to the aggregator's retirement, so one row is written per finished
 * execution rather than per event — a streaming task emitting dozens of
 * snapshots still writes once. Nothing is recorded unless a caller attaches
 * this; the graph itself only emits.
 *
 * The returned detach awaits writes still in flight, so a caller that tears
 * down at run end does not lose the last rows. A checkpoint's storage charge is
 * only known when the run's ResourceScope disposes it, so detach AFTER that
 * disposal: `runGraph` awaits it before resolving when it owns the scope, but a
 * caller-owned scope must be disposed by the caller first or its row is lost.
 */
export function attachUsageRecorder(
  aggregator: GraphUsageAggregator,
  storage: RunUsageStorage,
  options: UsageRecorderOptions
): () => Promise<void> {
  const clock = options.now ?? ((): string => new Date().toISOString());
  const pending = new Set<Promise<unknown>>();
  let sequence = 0;

  const off = aggregator.onRetire((row) => {
    const write = storage
      .put({
        runId: options.runId,
        sequence: sequence++,
        taskId: row.taskId,
        modelId: row.modelId ?? null,
        input: row.usage.input ?? null,
        output: row.usage.output ?? null,
        cached: row.usage.cached ?? null,
        cacheWrite: row.usage.cacheWrite ?? null,
        imageInput: row.usage.imageInput ?? null,
        imageCached: row.usage.imageCached ?? null,
        reasoning: row.usage.reasoning ?? null,
        total: row.usage.total ?? null,
        extra: row.usage.extra ? JSON.stringify(row.usage.extra) : null,
        createdAt: clock(),
      })
      .catch((err: unknown) => {
        // Losing a telemetry row must not fail the run that produced it.
        getLogger().warn("usage recorder write failed", { runId: options.runId, error: err });
      });
    pending.add(write);
    void write.finally(() => pending.delete(write));
  });

  return async (): Promise<void> => {
    off();
    await Promise.all([...pending]);
  };
}
