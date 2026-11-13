/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, TaskGraph } from "@workglow/task-graph";
import { concurrencyLimitOf, isIteratorTask } from "../ui/model/iteratorTask";
import type { RunEventSink } from "./runEventChannel";

/**
 * How deep to follow ownership. A task that owns a workflow produces a wrapper
 * row whose own children are the real work, so one level is never enough —
 * stopping at the wrapper reports "Workflow" and hides the pipeline inside it.
 * Mirrors the terminal's `MAX_SUBTASK_DEPTH`, plus the level that wrapper eats.
 */
export const MAX_PROJECTED_DEPTH = 3;

/**
 * How often to sweep an iterator for clones it started without announcing.
 *
 * Owned subgraphs need no poll: `Task` emits `regenerate` on its own event bus
 * the moment its subgraph gains a task, so attaching is a subscription rather
 * than a guess. The terminal attaches on the same event, for the same reason —
 * a poll silently loses any subtask that starts and finishes inside one
 * interval, which on a fast pipeline is most of them.
 */
const ITERATION_SWEEP_MS = 150;

/**
 * Live iteration clones reported at once, when the iterator states no
 * concurrency limit of its own. A Map over a worklist of thousands has that
 * many clones over its life and a handful in flight; reporting the history
 * would put one `task_added` per item on a pipe for nothing.
 */
const DEFAULT_MAX_LIVE_CLONES = 4;

/** Hard ceiling on clones regardless of what an iterator claims it runs. */
const MAX_LIVE_CLONES = 8;

const NOOP = (): void => {};

function isSettled(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "ABORTED";
}

function subGraphOf(task: ITask): TaskGraph | undefined {
  return (task as { subGraph?: TaskGraph }).subGraph;
}

function hasChildren(task: ITask): boolean {
  const probe = (task as { hasChildren?: () => boolean }).hasChildren;
  return typeof probe === "function" ? probe.call(task) : subGraphOf(task) !== undefined;
}

function liveIterationGraphs(task: ITask): Array<{ index: number; graph: TaskGraph }> {
  const probe = (
    task as { getVisibleIterationGraphs?: () => Array<{ index: number; graph: TaskGraph }> }
  ).getVisibleIterationGraphs;
  return typeof probe === "function" ? (probe.call(task) ?? []) : [];
}

/** Signature of {@link projectRunEvents}, taken as a parameter to break the cycle. */
export type ProjectGraph = (
  graph: TaskGraph,
  sink: RunEventSink,
  options: { depth: number; parent: string; removeRowsOnStop?: boolean }
) => () => void;

/**
 * Reports what one task owns: either its own subgraph, or — for a Map/Reduce,
 * whose subgraph is the idle template rather than the running work — the live
 * clones of its in-flight iterations.
 */
export function projectTaskSubtree(
  task: ITask,
  sink: RunEventSink,
  depth: number,
  parent: string,
  project: ProjectGraph
): () => void {
  if (depth + 1 >= MAX_PROJECTED_DEPTH) return NOOP;
  return isIteratorTask(task)
    ? projectIterationClones(task, sink, depth, parent, project)
    : projectOwnedSubgraph(task, sink, depth, parent, project);
}

function projectOwnedSubgraph(
  task: ITask,
  sink: RunEventSink,
  depth: number,
  parent: string,
  project: ProjectGraph
): () => void {
  let stop: (() => void) | undefined;

  const tryAttach = (): void => {
    if (stop) return;
    const sub = subGraphOf(task);
    if (!hasChildren(task) || !sub) return;
    // The subgraph is created once and kept, so one attach is enough. Rows stay
    // after it stops: ownership is a fact about the run, and a completed
    // subtree is most of what a finished run has to show.
    stop = project(sub, sink, { depth: depth + 1, parent });
  };

  // A task owns its children partway through `execute()`, so the subgraph is
  // almost always empty right now. `regenerate` is emitted the moment one is
  // added — including for a child that starts and finishes in a few
  // milliseconds, which any poll interval would step straight over.
  task.events.on("regenerate", tryAttach);
  tryAttach();

  return () => {
    task.events.off("regenerate", tryAttach);
    stop?.();
  };
}

/**
 * Map/Reduce iterations. Each in-flight iteration is a cloned graph, and it is
 * the clone — not the iterator's template subgraph — that holds the work worth
 * watching, which is why the terminal skips the template too.
 *
 * Only running clones are reported, and only up to the iterator's own
 * concurrency limit: a finished iteration's rows are removed to make room, so
 * the row set tracks what is in flight rather than growing with the worklist.
 */
function projectIterationClones(
  task: ITask,
  sink: RunEventSink,
  depth: number,
  parent: string,
  project: ProjectGraph
): () => void {
  const live = new Map<number, () => void>();
  const cap = Math.max(
    1,
    Math.min(concurrencyLimitOf(task) ?? DEFAULT_MAX_LIVE_CLONES, MAX_LIVE_CLONES)
  );

  const attach = (index: number, graph: TaskGraph | undefined): void => {
    if (!graph || live.has(index) || live.size >= cap) return;
    live.set(index, project(graph, sink, { depth: depth + 1, parent, removeRowsOnStop: true }));
  };

  const release = (index: number): void => {
    const stop = live.get(index);
    if (!stop) return;
    live.delete(index);
    stop();
  };

  const onStart = (index: number, _count: number, graph?: TaskGraph): void => attach(index, graph);
  const onProgress = (
    index: number,
    _count: number,
    _p?: number,
    _m?: string,
    graph?: TaskGraph
  ): void => attach(index, graph);
  const onComplete = (index: number): void => release(index);

  task.events.on("iteration_start", onStart);
  task.events.on("iteration_progress", onProgress);
  task.events.on("iteration_complete", onComplete);

  // A nested Map commonly starts an iteration before this wiring exists, so the
  // events alone would miss the clone that is already running.
  const sweep = setInterval(() => {
    for (const { index, graph } of liveIterationGraphs(task)) attach(index, graph);
    if (isSettled(task.status)) {
      for (const index of [...live.keys()]) release(index);
      clearInterval(sweep);
    }
  }, ITERATION_SWEEP_MS);
  if (sweep.unref) sweep.unref();

  return () => {
    clearInterval(sweep);
    task.events.off("iteration_start", onStart);
    task.events.off("iteration_progress", onProgress);
    task.events.off("iteration_complete", onComplete);
    for (const stop of live.values()) stop();
    live.clear();
  };
}
