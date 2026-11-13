/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, TaskGraph } from "@workglow/task-graph";
import { useEffect, useState } from "react";
import { isIteratorTask } from "../model/iteratorTask";
import { sortCliTaskLinesForDisplay, startGraphTaskPoll } from "../cliTaskUi";
import type { CliTaskLine, IterationSlotRow } from "../taskGraphCliSubscriptions";
import { cliTaskLabel, subscribeTaskGraphForCli } from "../taskGraphCliSubscriptions";

export interface SubtaskRowsState {
  /** Owned subtasks in display order (completed → running → pending, then graph order). */
  readonly rows: readonly CliTaskLine[];
  /**
   * The live task behind each row, keyed by row id. A row that owns tasks of its
   * own — an owned workflow wrapping a whole pipeline, say — needs its instance
   * so the renderer can recurse into that subgraph instead of stopping at the
   * wrapper row.
   */
  readonly tasks: ReadonlyMap<string, ITask>;
  /** Aggregate progress of the subgraph, once it reports any. */
  readonly overallProgress: number | undefined;
  readonly iterationSlots: ReadonlyMap<string, IterationSlotRow[]>;
}

const EMPTY_SUBTASK_ROWS: SubtaskRowsState = {
  rows: [],
  tasks: new Map(),
  overallProgress: undefined,
  iterationSlots: new Map(),
};

function taskToCliLine(task: ITask): CliTaskLine {
  return {
    id: String(task.id),
    type: (task as { type?: string }).type ?? "Unknown",
    label: cliTaskLabel(task),
    status: String(task.status),
  };
}

function linesFromTasks(tasks: readonly ITask[]): Map<string, CliTaskLine> {
  return new Map(tasks.map((t) => [String(t.id), taskToCliLine(t)]));
}

/**
 * Subscribe to an already-populated graph (a Map iteration clone) the same way
 * {@link useSubtaskRows} subscribes to a task's owned subgraph.
 */
export function useGraphTaskRows(graph: TaskGraph): SubtaskRowsState {
  const children = graph.getTasks();
  const [taskInfos, setTaskInfos] = useState<Map<string, CliTaskLine>>(() =>
    linesFromTasks(children)
  );
  const [overallProgress, setOverallProgress] = useState<number | undefined>(undefined);
  const [iterationSlots, setIterationSlots] = useState<Map<string, IterationSlotRow[]>>(new Map());

  useEffect(() => {
    const unsub = subscribeTaskGraphForCli(
      graph,
      setTaskInfos,
      undefined,
      setOverallProgress,
      setIterationSlots
    );
    const stopPoll = startGraphTaskPoll(graph, setTaskInfos);
    return () => {
      unsub();
      stopPoll();
    };
  }, [graph]);

  const order = new Map(children.map((t, i) => [String(t.id), i]));
  const tasks = new Map(children.map((t) => [String(t.id), t]));
  const rowsSource =
    taskInfos.size > 0 ? Array.from(taskInfos.values()) : children.map(taskToCliLine);

  return {
    rows: sortCliTaskLinesForDisplay(rowsSource, order),
    tasks,
    overallProgress,
    iterationSlots,
  };
}

/**
 * Tracks the tasks a running task owns via `context.own()`.
 *
 * A task's `subGraph` is usually empty when the row first mounts — children are
 * added as `execute()` reaches them — so the subgraph is attached lazily, then
 * subscribed once with the same {@link subscribeTaskGraphForCli} the top-level
 * graph uses.
 *
 * The signal to attach on is the task's OWN `regenerate` event, which `Task`
 * emits the moment its subgraph gains a task. No graph-level listener sees it,
 * which is why this used to poll `hasChildren()` instead — but this hook holds
 * the task, and a poll silently loses any subtask that starts and finishes
 * inside one interval, which on a fast pipeline is most of them.
 */
export function useSubtaskRows(task: ITask): SubtaskRowsState {
  const skipTemplate = isIteratorTask(task);
  const [taskInfos, setTaskInfos] = useState<Map<string, CliTaskLine>>(new Map());
  const [overallProgress, setOverallProgress] = useState<number | undefined>(undefined);
  const [iterationSlots, setIterationSlots] = useState<Map<string, IterationSlotRow[]>>(new Map());

  useEffect(() => {
    if (skipTemplate) return;
    let unsub: (() => void) | undefined;
    let stopPoll: (() => void) | undefined;

    const tryAttach = (): void => {
      if (unsub) return;
      if (!task.hasChildren() || !task.subGraph) return;
      unsub = subscribeTaskGraphForCli(
        task.subGraph,
        setTaskInfos,
        undefined,
        setOverallProgress,
        setIterationSlots
      );
      stopPoll = startGraphTaskPoll(task.subGraph, setTaskInfos);
    };

    // Fires when the subgraph gains a task, so a child is attached as it is
    // owned rather than at the next tick of a timer. The subgraph is created
    // once and kept, so `tryAttach` is a no-op after the first one lands.
    task.events.on("regenerate", tryAttach);
    // A row that mounts after its task already owns children gets no further
    // `regenerate`, so the current state has to be read once up front.
    tryAttach();

    return () => {
      task.events.off("regenerate", tryAttach);
      unsub?.();
      stopPoll?.();
    };
  }, [task, skipTemplate]);

  if (skipTemplate) return EMPTY_SUBTASK_ROWS;

  const children = task.hasChildren() && task.subGraph ? task.subGraph.getTasks() : [];
  const order = new Map(children.map((t, i) => [String(t.id), i]));
  const tasks = new Map(children.map((t) => [String(t.id), t]));

  return {
    rows: sortCliTaskLinesForDisplay(Array.from(taskInfos.values()), order),
    tasks,
    overallProgress,
    iterationSlots,
  };
}
