/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util";
import type { Usage } from "../task/StreamTypes";
import { mergeUsage, USAGE_COUNTER_FIELDS } from "../task/StreamTypes";

/** One finished execution's final token total. */
export interface RetiredUsage {
  readonly taskId: string;
  readonly modelId: string | undefined;
  readonly usage: Usage;
}

/**
 * Stands in for an unnamed model so every such report shares one bucket.
 * A Symbol, not a string, so it can never collide with a real model id.
 */
export const UNNAMED_MODEL = Symbol.for("workglow.usage.unnamedModel");

export type ModelKey = string | typeof UNNAMED_MODEL;

const modelKey = (modelId: string | undefined): ModelKey => modelId ?? UNNAMED_MODEL;

/**
 * A NUL. Built rather than written as an escape sequence: a raw control
 * character in source is invisible to a reader and makes git treat the whole
 * file as binary, while the escape that avoids that is itself rewritten back
 * into one by anything that carries the file through a JSON string.
 */
const NUL = String.fromCharCode(0);

/**
 * Task id the per-task rollup folds evicted rows into, so
 * {@link GraphUsageAggregator.byTask} keeps summing to
 * {@link GraphUsageAggregator.total} once the cap is reached. Prefixed with a
 * control character that no `TaskConfig.id` can be, so it can never shadow a
 * real task.
 */
export const EVICTED_TASKS = `${NUL}workglow.usage.evictedTasks`;

/**
 * Per-task rows kept before older ones fold into {@link EVICTED_TASKS}.
 *
 * The per-task rollup exists to label the rows of a graph a UI is rendering, so
 * it is sized for that: a graph with more than a few hundred nodes has no
 * per-task display to feed. The rows that blow past it are not graph nodes at
 * all — `IteratorTaskRunner` clones its subgraph per iteration and mints a fresh
 * uuid for every clone, so an AI map over a corpus mints one id per ITEM and the
 * map grew by a `Usage` plus a 36-char key per filing for the life of the run,
 * keyed by ids nothing will ever look up.
 */
const MAX_RETIRED_TASK_ROWS = 512;

/**
 * Folds per-task token totals into one run total.
 *
 * Each task event carries that task's **cumulative** total, so live buckets are
 * replaced, never merged — merging would count the same tokens once per event.
 * Only *finished* executions are added into `retired`, which is what lets a task
 * that runs more than once per run (While / Fallback / GraphAsTask reuse stable
 * ids across iterations) contribute every iteration instead of only its last.
 *
 * Buckets are keyed by task **and model**, nested (task -> model -> usage) so a
 * task id or model id containing arbitrary characters (including whitespace —
 * `TaskConfig.id` is typed `unknown`, not restricted to a safe string shape)
 * can never collide with a different task/model pair the way a composed string
 * key would. A task spanning two models reports two totals rather than one
 * blend, and per-model rollups need no second pass.
 */
export class GraphUsageAggregator {
  private readonly live = new Map<string, Map<ModelKey, RetiredUsage>>();
  private retired: Usage | undefined;
  private readonly retiredByTask = new Map<string, Usage>();
  private readonly retiredByModel = new Map<ModelKey, Usage>();
  private readonly retireListeners = new Set<(row: RetiredUsage) => void>();

  /**
   * The run's aggregate so far. A `0` here means at least one contributor
   * stated `0`, not that all did — see {@link mergeUsage}. Per-execution rows
   * keep that distinction; this total cannot.
   */
  get total(): Usage | undefined {
    let running = this.retired;
    for (const models of this.live.values()) {
      for (const row of models.values()) running = mergeUsage(running, row.usage);
    }
    return running;
  }

  /**
   * The run's total so far per task, across every model that task used and
   * every time it executed. A display keyed by task must fold the model axis
   * itself — a task spanning an embedding and a generation model holds two
   * live buckets, and showing whichever reported last is not its spend.
   *
   * Retains the most recently active {@link MAX_RETIRED_TASK_ROWS} tasks;
   * anything older is folded into the {@link EVICTED_TASKS} row, so the map
   * still sums to {@link total} but a specific old id may no longer be present.
   * Look up a task you are rendering, not one you no longer hold a node for.
   */
  byTask(): ReadonlyMap<string, Usage> {
    const out = new Map(this.retiredByTask);
    for (const [taskId, models] of this.live) {
      let running = out.get(taskId);
      for (const row of models.values()) running = mergeUsage(running, row.usage);
      if (running) out.set(taskId, running);
    }
    return out;
  }

  /**
   * The run's total so far per model, across every task that used it. The
   * mirror of {@link byTask}: a display keyed by model must fold the task
   * axis, or two tasks sharing one model report only the later one and the
   * per-model rows no longer sum to {@link total}.
   */
  byModel(): ReadonlyMap<ModelKey, Usage> {
    const out = new Map(this.retiredByModel);
    for (const models of this.live.values()) {
      for (const [key, row] of models) {
        const merged = mergeUsage(out.get(key), row.usage);
        if (merged) out.set(key, merged);
      }
    }
    return out;
  }

  /** Subscribe to executions as they finish. Returns an unsubscribe. */
  onRetire(cb: (row: RetiredUsage) => void): () => void {
    this.retireListeners.add(cb);
    return () => this.retireListeners.delete(cb);
  }

  /**
   * Clear every bucket and total for a fresh run, keeping subscribers attached.
   *
   * A run must start from zero, but replacing the instance to get there strands
   * anyone who subscribed beforehand — and a caller can only reach the
   * aggregator before starting a run, so that is every external subscriber.
   * They would then record nothing and raise nothing.
   */
  reset(): void {
    this.live.clear();
    this.retired = undefined;
    this.retiredByTask.clear();
    this.retiredByModel.clear();
  }

  observe(taskId: string, usage: Usage, modelId: string | undefined): void {
    const key = modelKey(modelId);
    const existing = this.live.get(taskId)?.get(key);
    // A cumulative total never shrinks within one execution, so a smaller one
    // means a fresh execution started without a completion signal (a failed
    // Fallback alternative being retried).
    if (existing && isSmaller(usage, existing.usage)) this.retireBucket(taskId, key);
    // Re-resolve after a possible retire above — retiring the last bucket for
    // a task drops its now-empty inner map from `live`, so the map fetched
    // before that call may no longer be the one `live` holds.
    let models = this.live.get(taskId);
    if (!models) {
      models = new Map<ModelKey, RetiredUsage>();
      this.live.set(taskId, models);
    }
    models.set(key, { taskId, modelId, usage });
  }

  /** Retire every live bucket for a task (all of its models). */
  retire(taskId: string): void {
    const models = this.live.get(taskId);
    if (!models) return;
    for (const key of [...models.keys()]) this.retireBucket(taskId, key);
  }

  /** Retire everything still live — call once at run end. */
  sweep(): void {
    for (const taskId of [...this.live.keys()]) this.retire(taskId);
  }

  /**
   * Add a charge that settles after its execution finished — provider cache
   * storage, billed at disposal. Merged into the retired totals rather than
   * replacing a bucket: unlike a `usage` snapshot this is a delta, and the
   * execution it belongs to was retired long before it arrived.
   */
  chargeLate(taskId: string, usage: Usage, modelId: string | undefined): void {
    const key = modelKey(modelId);
    this.retired = mergeUsage(this.retired, usage);
    this.bumpTaskRow(taskId, usage);
    this.retiredByModel.set(key, mergeUsage(this.retiredByModel.get(key), usage) ?? usage);
    this.notifyRetire({ taskId, modelId, usage });
  }

  private retireBucket(taskId: string, key: ModelKey): void {
    const models = this.live.get(taskId);
    const row = models?.get(key);
    if (!models || !row) return;
    models.delete(key);
    if (models.size === 0) this.live.delete(taskId);
    // An estimate is display feedback, not accounting. Dropping it here rather
    // than folding it into `retired` is what keeps a character-count guess out
    // of the persisted run total and out of every cost figure derived from it;
    // it still contributed to `total` for as long as it was live.
    if (row.usage.estimated) return;
    this.retired = mergeUsage(this.retired, row.usage);
    this.bumpTaskRow(taskId, row.usage);
    this.evictOldestTaskRows();
    this.retiredByModel.set(key, mergeUsage(this.retiredByModel.get(key), row.usage) ?? row.usage);
    this.notifyRetire(row);
  }

  /**
   * Records a task's spend and marks it the most recently active.
   *
   * Deletes before setting, because `Map.set` on a key that already exists
   * updates the value and leaves the insertion order alone. Without the delete
   * a task keeps the position it first took, so {@link evictOldestTaskRows}
   * would evict a task that is still reporting while holding one that went
   * quiet after its first execution — the opposite of what the cap is for.
   */
  private bumpTaskRow(taskId: string, usage: Usage): void {
    const merged = mergeUsage(this.retiredByTask.get(taskId), usage) ?? usage;
    this.retiredByTask.delete(taskId);
    this.retiredByTask.set(taskId, merged);
  }

  /**
   * Folds the oldest per-task rows into {@link EVICTED_TASKS} once the map
   * holds more than {@link MAX_RETIRED_TASK_ROWS} real tasks.
   *
   * Folded rather than dropped: `byTask()` summing to `total` is a stated
   * property of this class, and a plain eviction would break it silently — the
   * run total would keep counting spend that no per-task row accounted for.
   *
   * The overflow bucket is exempt from the cap rather than counted against it.
   * Counting it means the first overflow evicts twice: one real row leaves, the
   * bucket arrives in its place, the size is unchanged and the loop goes round
   * again — so the steady state would be `MAX_RETIRED_TASK_ROWS - 1` real
   * tasks, one fewer than the constant says.
   */
  private evictOldestTaskRows(): void {
    const cap = () => MAX_RETIRED_TASK_ROWS + (this.retiredByTask.has(EVICTED_TASKS) ? 1 : 0);
    while (this.retiredByTask.size > cap()) {
      let oldest: string | undefined;
      for (const id of this.retiredByTask.keys()) {
        // Never the overflow bucket itself: folding it into itself would drop
        // the total it carries and re-break the sum it exists to preserve.
        if (id === EVICTED_TASKS) continue;
        oldest = id;
        break;
      }
      if (oldest === undefined) return;
      const usage = this.retiredByTask.get(oldest)!;
      this.retiredByTask.delete(oldest);
      this.retiredByTask.set(
        EVICTED_TASKS,
        mergeUsage(this.retiredByTask.get(EVICTED_TASKS), usage) ?? usage
      );
    }
  }

  /**
   * A telemetry subscriber that throws must not take down the run that
   * produced the numbers, nor starve the subscribers registered after it.
   */
  private notifyRetire(row: RetiredUsage): void {
    for (const cb of this.retireListeners) {
      try {
        cb(row);
      } catch (err) {
        getLogger().error("usage retire listener threw", { taskId: row.taskId, error: err });
      }
    }
  }
}

/**
 * True when `next` reports strictly less than `prev` on any counter both state.
 * Only counters present on both sides participate — a newly-reported counter is
 * not a decrease.
 */
function isSmaller(next: Usage, prev: Usage): boolean {
  for (const field of USAGE_COUNTER_FIELDS) {
    const a = next[field];
    const b = prev[field];
    if (a !== undefined && b !== undefined && a < b) return true;
  }
  return false;
}
