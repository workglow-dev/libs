/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, StreamEvent, TaskGraph, TaskIdType, Usage } from "@workglow/task-graph";
import { cliTaskLabel } from "../ui/taskGraphCliSubscriptions";
import { projectTaskSubtree } from "./projectSubtrees";
import type { RunEventSink } from "./runEventChannel";

export interface ProjectRunEventsOptions {
  /** Nesting level reported on every row this projection adds. */
  readonly depth?: number;
  /** Row that owns this graph, when it is a subgraph rather than the run's own. */
  readonly parent?: string;
  /**
   * Emit `task_removed` for every row added, when this projection stops. Right
   * for a Map's iteration clone, which is real only while it runs; wrong for an
   * owned subgraph, whose rows are most of what a finished run has to show.
   */
  readonly removeRowsOnStop?: boolean;
}

/**
 * Subscribes a running graph and reports it as {@link RunEvent}s.
 *
 * The wiring rules are the terminal UI's, and they are not obvious: wire on
 * `task_added`, UNwire on `task_removed` (a task released with `disown` can be
 * owned again, and without dropping its listeners the loop would stack a new
 * pair every cycle), and read the label per event rather than caching it (a
 * reused instance is relabelled per job). Aggregate progress, per-task usage
 * and stream chunks are already bridged up by the graph — including from
 * nested subgraphs — so those come from the graph rather than from each task.
 */
export function projectRunEvents(
  graph: TaskGraph,
  sink: RunEventSink,
  options: ProjectRunEventsOptions = {}
): () => void {
  const depth = options.depth ?? 0;
  const parent = options.parent;
  const wired = new Map<string, () => void>();
  const addedRows: string[] = [];

  const wire = (task: ITask): void => {
    const id = String(task.id);
    if (wired.has(id)) return;
    sink.emit({
      k: "task_added",
      id,
      type: (task as { type?: string }).type ?? "Unknown",
      label: cliTaskLabel(task),
      depth,
      ...(parent === undefined ? {} : { parent }),
    });
    addedRows.push(id);

    const onStatus = (status: string): void => sink.emit({ k: "status", id, status });
    const onProgress = (progress: number | undefined, message?: string): void =>
      sink.emit({ k: "progress", id, progress, message });
    const onIterationStart = (index: number, count: number): void =>
      sink.emit({ k: "iteration", id, index, count, phase: "start" });
    const onIterationComplete = (index: number, count: number): void =>
      sink.emit({ k: "iteration", id, index, count, phase: "complete" });
    const onIterationProgress = (
      index: number,
      count: number,
      progress: number | undefined,
      message?: string
    ): void =>
      sink.emit({ k: "iteration", id, index, count, phase: "progress", progress, message });

    task.events.on("status", onStatus);
    task.events.on("progress", onProgress);
    task.events.on("iteration_start", onIterationStart);
    task.events.on("iteration_complete", onIterationComplete);
    task.events.on("iteration_progress", onIterationProgress);

    // What this task owns — its own subgraph, or a Map's live iteration clones
    // — is where the actual work of a sweep lives. Reporting only the top-level
    // graph left `sec sync reg-a` showing a While Loop and nothing beneath it.
    const stopSubtree = projectTaskSubtree(task, sink, depth, id, projectRunEvents);

    wired.set(id, () => {
      task.events.off("status", onStatus);
      task.events.off("progress", onProgress);
      task.events.off("iteration_start", onIterationStart);
      task.events.off("iteration_complete", onIterationComplete);
      task.events.off("iteration_progress", onIterationProgress);
      stopSubtree();
    });
  };

  for (const task of graph.getTasks()) wire(task);

  const onAdded = (taskId: TaskIdType): void => {
    const task = graph.getTask(taskId);
    if (task) wire(task);
  };
  const onRemoved = (taskId: TaskIdType): void => {
    const id = String(taskId);
    wired.get(id)?.();
    wired.delete(id);
    sink.emit({ k: "task_removed", id });
  };
  const onGraphProgress = (progress: number | undefined): void =>
    sink.emit({ k: "graph_progress", progress });
  const onGraphUsage = (total: Usage): void =>
    sink.emit({ k: "graph_usage", input: total.input, output: total.output, cached: total.cached });
  const onTaskUsage = (taskId: TaskIdType, usage: Usage, modelId: string | undefined): void =>
    sink.emit({
      k: "usage",
      id: String(taskId),
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      modelId,
    });
  const onChunk = (taskId: TaskIdType, event: StreamEvent): void => {
    if (event.type === "text-delta") {
      // A task's reasoning streams beside its reply on its own port; folded into
      // the row's text it would read as part of the answer.
      if ((event.port ?? "text") !== "text") return;
      const delta = (event as { textDelta?: string; text?: string }).textDelta ?? "";
      if (delta) sink.emit({ k: "text", id: String(taskId), delta });
    } else if (event.type === "object-delta" && (event as { port?: string }).port === "messages") {
      const task = graph.getTask(taskId);
      sink.emit({
        k: "messages",
        id: String(taskId),
        messages: task?.runOutputData?.messages,
      });
    }
  };

  graph.on("task_added", onAdded);
  graph.on("task_removed", onRemoved);
  graph.subscribe("graph_progress", onGraphProgress);
  graph.subscribe("graph_usage", onGraphUsage);
  graph.subscribe("task_usage", onTaskUsage);
  graph.subscribe("task_stream_chunk", onChunk);

  return () => {
    for (const unwire of wired.values()) unwire();
    wired.clear();
    if (options.removeRowsOnStop) {
      for (const id of addedRows) sink.emit({ k: "task_removed", id });
    }
    addedRows.length = 0;
    graph.off("task_added", onAdded);
    graph.off("task_removed", onRemoved);
    graph.off("graph_progress", onGraphProgress);
    graph.off("graph_usage", onGraphUsage);
    graph.off("task_usage", onTaskUsage);
    graph.off("task_stream_chunk", onChunk);
  };
}

/** A single-task run: the task itself is row 0, its owned subgraph is depth 1. */
export function projectTaskRunEvents(task: ITask, sink: RunEventSink): () => void {
  const id = String(task.id);
  // The parent row is announced first: a child naming a `parent` the console
  // has not seen has nowhere to attach.
  sink.emit({
    k: "task_added",
    id,
    type: (task as { type?: string }).type ?? "Unknown",
    label: cliTaskLabel(task),
    depth: 0,
  });
  // Lazily, because a task's subgraph is empty until `execute()` reaches the
  // children — reading it once here saw nothing and reported nothing.
  const stopSubgraph = projectTaskSubtree(task, sink, 0, id, projectRunEvents);
  const onStatus = (status: string): void => sink.emit({ k: "status", id, status });
  const onProgress = (progress: number | undefined, message?: string): void =>
    sink.emit({ k: "progress", id, progress, message });
  const onUsage = (usage: Usage, modelId: string | undefined): void =>
    sink.emit({
      k: "usage",
      id,
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      modelId,
    });
  task.events.on("status", onStatus);
  task.events.on("progress", onProgress);
  task.events.on("usage", onUsage);
  return () => {
    task.events.off("status", onStatus);
    task.events.off("progress", onProgress);
    task.events.off("usage", onUsage);
    stopSubgraph();
  };
}
