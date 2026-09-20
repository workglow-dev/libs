/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, TaskGraph } from "@workglow/task-graph";
import { Box, Text } from "ink";
import React from "react";
import { AggregateProgressRow } from "../components/AggregateProgressRow";
import { useVisibleRows } from "../components/RunViewport";
import { TaskErrorDetail } from "../components/TaskErrorDetail";
import { TaskStatusProgressRow } from "../components/TaskStatusProgressRow";
import {
  iterationSummaryLine,
  ownershipWrapperStatus,
  runAggregateProgress,
} from "../model/runRowModel";
import { HIDDEN_ABOVE_GLYPH, HIDDEN_BELOW_GLYPH, hiddenSiblingsLine } from "../model/runViewport";
import type { CliTaskLine, IterationSlotRow } from "../taskGraphCliSubscriptions";
import { mergeLiveIterationGraphs, visibleIterationSlots } from "../taskGraphCliSubscriptions";
import { iterationGroupKey, iterationListKey } from "../useRunCensus";
import { settledTaskDurationMs } from "./taskDuration";
import {
  concurrencyLimitOf,
  isIteratorTask,
  useGraphTaskRows,
  useSubtaskRows,
} from "./useSubtaskRows";
import { useTaskUsageLine } from "./useTaskUsageLine";

/**
 * How many levels of owned subgraph to render beneath a task row. A task that
 * owns a workflow produces a wrapper row whose own children are the real work,
 * so one level is never enough — stopping at the wrapper shows "Workflow" and
 * hides the pipeline inside it. Deeper than this and the breadth cap multiplies
 * into more rows (and more attach pollers) than a terminal can use.
 */
const MAX_SUBTASK_DEPTH = 2;

/** One line naming the siblings a list is holding back at one end of its window. */
function HiddenSiblingsLine({
  hidden,
  glyph = HIDDEN_ABOVE_GLYPH,
}: {
  readonly hidden: readonly CliTaskLine[];
  readonly glyph?: string;
}): React.ReactElement | null {
  const text = hiddenSiblingsLine(
    hidden.map((row) => row.status),
    glyph
  );
  if (!text) return null;
  return <Text dimColor>{text}</Text>;
}

/**
 * Live Map/Reduce iterations: at most `concurrencyLimit` running clones, each
 * rendered as a normal task tree (title + owned subtasks), not `#1`/`#2`.
 */
export function IterationTaskRows({
  task,
  nodeKey,
  slots,
  concurrencyLimit,
}: {
  readonly task: ITask;
  /** Census path of the iterator's own row; its iterations hang off it. */
  readonly nodeKey: string;
  readonly slots: readonly IterationSlotRow[] | undefined;
  readonly concurrencyLimit: number | undefined;
}): React.ReactElement | null {
  const merged = mergeLiveIterationGraphs(slots, task);
  const inFlight = visibleIterationSlots(merged, concurrencyLimit);
  // The concurrency cap says how many iterations exist to show; the viewport
  // plan says how many the terminal can afford. The smaller wins.
  const { visible } = useVisibleRows(iterationGroupKey(nodeKey), inFlight);
  if (visible.length === 0) return null;
  const summary = iterationSummaryLine(merged, visible.length);
  return (
    <Box flexDirection="column">
      {visible.map((slot) =>
        slot.graph ? (
          <IterationGraphRows
            key={slot.index}
            graph={slot.graph}
            listKey={iterationListKey(nodeKey, slot.index)}
          />
        ) : null
      )}
      {summary ? <Text dimColor>{`  ${summary}`}</Text> : null}
    </Box>
  );
}

function IterationGraphRows({
  graph,
  listKey,
}: {
  readonly graph: TaskGraph;
  readonly listKey: string;
}): React.ReactElement | null {
  const state = useGraphTaskRows(graph);
  if (state.rows.length === 0) return null;
  return (
    <SubtaskRows
      listKey={listKey}
      rows={state.rows}
      tasks={state.tasks}
      iterationSlots={state.iterationSlots}
    />
  );
}

interface SubtaskRowsProps {
  /** Census path of this sibling group; the viewport plan is keyed by it. */
  readonly listKey: string;
  readonly rows: readonly CliTaskLine[];
  readonly iterationSlots: ReadonlyMap<string, IterationSlotRow[]>;
  /** Live task per row id; enables recursion into rows that own subgraphs. */
  readonly tasks?: ReadonlyMap<string, ITask> | undefined;
  /** Nesting level of this list; recursion stops at {@link MAX_SUBTASK_DEPTH}. */
  readonly depth?: number;
  /** Aggregate subgraph progress; only rendered in `chrome` mode. */
  readonly overallProgress?: number | undefined;
  /**
   * `chrome` adds the "Subtasks" heading and subgraph progress bar — right for
   * the single-task view, where the subgraph is the whole screen. `compact`
   * (the default) just indents the rows under their parent, so a graph of N
   * task rows does not grow N headings.
   */
  readonly variant?: "compact" | "chrome";
}

/**
 * Renders the tasks a task owns (`context.own`) as indented rows beneath it.
 * Shared by {@link DefaultTaskRow} (workflow/graph runs) and `TaskRunApp`
 * (single-task runs) so both views show ownership the same way.
 */
/**
 * One subtask row plus, when that subtask owns tasks of its own, its children
 * indented beneath it. Split out as a component because the subgraph is tracked
 * with a hook, which cannot be called from inside a `map` over a changing list.
 */
function SubtaskRow({
  line,
  nodeKey,
  task,
  iterationSlots,
  depth,
}: {
  readonly line: CliTaskLine;
  readonly nodeKey: string;
  readonly task: ITask | undefined;
  readonly iterationSlots: ReadonlyMap<string, IterationSlotRow[]>;
  readonly depth: number;
}): React.ReactElement {
  if (task === undefined) {
    return (
      <Box flexDirection="column">
        <TaskStatusProgressRow
          label={line.label}
          status={line.status}
          message={line.message}
          barProgress={line.progress}
        />
      </Box>
    );
  }
  return (
    <SubtaskStatusWithUsage
      task={task}
      line={line}
      nodeKey={nodeKey}
      iterationSlots={iterationSlots}
      depth={depth}
    />
  );
}

/**
 * One owned child: its status line, what it spent, and whatever it owns in
 * turn. Its own subgraph is tracked here rather than a level down because the
 * row's honest status depends on it — see {@link ownershipWrapperStatus}.
 */
function SubtaskStatusWithUsage({
  task,
  line,
  nodeKey,
  iterationSlots,
  depth,
}: {
  readonly task: ITask;
  readonly line: CliTaskLine;
  readonly nodeKey: string;
  readonly iterationSlots: ReadonlyMap<string, IterationSlotRow[]>;
  readonly depth: number;
}): React.ReactElement {
  const slots = iterationSlots.get(line.id);
  const usageLine = useTaskUsageLine(task);
  const nested = useSubtaskRows(task);
  const iterator = isIteratorTask(task);
  const status = ownershipWrapperStatus(
    line.status,
    nested.rows.map((row) => row.status)
  );
  const showsNested =
    depth < MAX_SUBTASK_DEPTH &&
    !iterator &&
    nested.rows.length > 0 &&
    !isRedundantSubgraph(nested.rows, line.type);
  return (
    <Box flexDirection="column">
      <TaskStatusProgressRow
        label={line.label}
        status={status}
        message={line.message}
        barProgress={line.progress}
        durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
      />
      {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      <TaskErrorDetail task={task} status={line.status} />
      <IterationTaskRows
        task={task}
        nodeKey={nodeKey}
        slots={slots}
        concurrencyLimit={concurrencyLimitOf(task)}
      />
      {showsNested && (
        <SubtaskRows
          listKey={nodeKey}
          rows={nested.rows}
          tasks={nested.tasks}
          iterationSlots={nested.iterationSlots}
          depth={depth + 1}
        />
      )}
    </Box>
  );
}

export function SubtaskRows({
  listKey,
  rows,
  iterationSlots,
  tasks,
  depth = 0,
  overallProgress,
  variant = "compact",
}: SubtaskRowsProps): React.ReactElement | null {
  const showChrome = variant === "chrome";
  const { visible, before, after } = useVisibleRows(listKey, rows);

  if (rows.length === 0 && !(showChrome && overallProgress !== undefined)) return null;

  const body = (
    <Box paddingLeft={2} flexDirection="column">
      {showChrome && overallProgress !== undefined && (
        <AggregateProgressRow
          label="Subgraph"
          progress={runAggregateProgress(overallProgress, rows)}
        />
      )}
      <HiddenSiblingsLine hidden={before} />
      {visible.map((t) => (
        <SubtaskRow
          key={t.id}
          line={t}
          nodeKey={`${listKey}/${t.id}`}
          task={tasks?.get(t.id)}
          iterationSlots={iterationSlots}
          depth={depth}
        />
      ))}
      <HiddenSiblingsLine hidden={after} glyph={HIDDEN_BELOW_GLYPH} />
    </Box>
  );

  if (!showChrome) return body;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Subtasks</Text>
      {body}
    </Box>
  );
}

/**
 * A single child of the same type as its parent is the same logical work seen
 * twice (a job-queue mirror, a task that owns a clone of itself), so the row
 * would just be noise.
 */
export function isRedundantSubgraph(rows: readonly CliTaskLine[], parentType: string): boolean {
  return rows.length === 1 && rows[0]?.type === parentType;
}

export { iterationSummaryLine };
