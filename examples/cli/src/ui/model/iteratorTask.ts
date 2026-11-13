/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask } from "@workglow/task-graph";

/**
 * MapTask / ReduceTask / ForEachTask: the subgraph is the idle template, not the
 * live iteration clones. Those clones arrive via `iteration_start` and are
 * rendered as ordinary task rows.
 */
export function isIteratorTask(task: ITask): boolean {
  return typeof (task as { analyzeIterationInput?: unknown }).analyzeIterationInput === "function";
}

export function concurrencyLimitOf(task: ITask): number | undefined {
  const limit = (task as { concurrencyLimit?: number }).concurrencyLimit;
  return typeof limit === "number" && limit >= 1 ? limit : undefined;
}
