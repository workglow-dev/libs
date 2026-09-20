/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskGraph } from "@workglow/task-graph";
import { Box, Text, useWindowSize } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { sortCliTaskLinesForDisplay, startGraphTaskPoll } from "./cliTaskUi";
import { AggregateProgressRow } from "./components/AggregateProgressRow";
import { deriveRunState, RunStatusBar } from "./components/RunStatusBar";
import { RunViewportProvider, useVisibleRows } from "./components/RunViewport";
import { ScrollRegion } from "./components/ScrollRegion";
import { HumanInteractionHost } from "./HumanInteractionHost";
import { runAggregateProgress } from "./model/runRowModel";
import { HIDDEN_BELOW_GLYPH, hiddenSiblingsLine, planRunViewport } from "./model/runViewport";
import { ChatTaskRow } from "./rows/ChatTaskRow";
import { DefaultTaskRow } from "./rows/DefaultTaskRow";
import { pickRenderer } from "./rows/pickRenderer";
import { StreamingTextRow } from "./rows/StreamingTextRow";
import type { CliTaskLine, IterationSlotRow } from "./taskGraphCliSubscriptions";
import { subscribeTaskGraphForCli } from "./taskGraphCliSubscriptions";
import { useGraphUsageLine } from "./useGraphUsageLine";
import { useRepaintOnResize } from "./useRepaintOnResize";
import { useGraphRunCensus } from "./useRunCensus";
import { useRunClock } from "./useRunClock";

/**
 * Rows the run keeps for itself outside the scrolling region: the footer and
 * its rule, plus one blank line so the shell prompt does not land flush against
 * the last row when the run ends.
 */
const RESERVED_ROWS = 3;

/** A region smaller than this shows nothing useful; better to overflow the window. */
const MIN_REGION_ROWS = 4;

interface WorkflowRunAppProps {
  readonly graph: TaskGraph;
  readonly input: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  /**
   * When set (e.g. from {@link Workflow.run}), runs this instead of `graph.run(input, config)` so
   * abort/output-cache/merge semantics match the Workflow API.
   */
  readonly runExecutor?: () => Promise<unknown>;
  readonly onComplete: (result: unknown) => void;
  readonly onError: (error: Error) => void;
}

export function WorkflowRunApp({
  graph,
  input,
  config,
  runExecutor,
  onComplete,
  onError,
}: WorkflowRunAppProps): React.ReactElement {
  const [taskInfos, setTaskInfos] = useState<Map<string, CliTaskLine>>(new Map());
  const [overallProgress, setOverallProgress] = useState<number | undefined>(undefined);
  const [iterationSlots, setIterationSlots] = useState<Map<string, IterationSlotRow[]>>(new Map());
  const runUsageLine = useGraphUsageLine(graph);
  const census = useGraphRunCensus(graph);
  // Ink re-reads this on every SIGWINCH, so a window that changes size
  // re-prices the plan on the next frame rather than at the next graph event.
  const windowSize = useWindowSize();
  useRepaintOnResize(windowSize.columns);

  useEffect(() => {
    const unsub = subscribeTaskGraphForCli(
      graph,
      setTaskInfos,
      undefined,
      setOverallProgress,
      setIterationSlots
    );

    const stopPoll = startGraphTaskPoll(graph, setTaskInfos);

    const runPromise = runExecutor ? runExecutor() : graph.run(input, config);
    runPromise.then((result) => onComplete(result)).catch((err) => onError(err));

    return () => {
      stopPoll();
      unsub();
    };
  }, [graph, onComplete, onError, runExecutor, input, config]);

  const order = new Map(graph.getTasks().map((t, i) => [String(t.id), i]));
  const orderedTasks = sortCliTaskLinesForDisplay(Array.from(taskInfos.values()), order);
  const runState = deriveRunState(orderedTasks.map((t) => t.status));
  const elapsedMs = useRunClock(runState === "running" || runState === "");

  const headerRows = overallProgress !== undefined ? 1 : 0;
  const budgetRows = Math.max(MIN_REGION_ROWS, windowSize.rows - RESERVED_ROWS - headerRows);
  const plan = useMemo(() => planRunViewport(census.tree, budgetRows), [census.tree, budgetRows]);

  return (
    <HumanInteractionHost>
      <Box flexDirection="column">
        {overallProgress !== undefined && (
          <AggregateProgressRow
            label="Workflow"
            progress={runAggregateProgress(overallProgress, orderedTasks)}
            emphasis
          />
        )}
        <RunViewportProvider
          plan={plan}
          slot={
            <ScrollRegion budgetRows={budgetRows}>
              <RootTaskRows graph={graph} rows={orderedTasks} iterationSlots={iterationSlots} />
            </ScrollRegion>
          }
        />
        <RunStatusBar
          usageLine={runUsageLine}
          counts={census.counts}
          state={runState}
          elapsedMs={elapsedMs}
          hiddenRows={plan.hidden}
        />
      </Box>
    </HumanInteractionHost>
  );
}

/**
 * The run's top-level rows. Capped by the same plan as every nested list — a
 * graph of forty parallel tasks is as capable of filling a terminal as one
 * task's map is.
 */
function RootTaskRows({
  graph,
  rows,
  iterationSlots,
}: {
  readonly graph: TaskGraph;
  readonly rows: readonly CliTaskLine[];
  readonly iterationSlots: ReadonlyMap<string, IterationSlotRow[]>;
}): React.ReactElement {
  const { visible, before, after } = useVisibleRows("", rows);
  const beforeLine = hiddenSiblingsLine(before.map((row) => row.status));
  const afterLine = hiddenSiblingsLine(
    after.map((row) => row.status),
    HIDDEN_BELOW_GLYPH
  );
  return (
    <Box flexDirection="column">
      {beforeLine ? <Text dimColor>{beforeLine}</Text> : null}
      {visible.map((t) => {
        const taskInstance = graph.getTasks().find((x) => String(x.id) === t.id);
        // Every id in rows comes from graph.getTasks(), so this lookup should
        // always succeed. Skip rendering if the invariant ever breaks rather
        // than masking it with a bogus cast.
        if (!taskInstance) return null;
        const Row = pickRenderer(t.type, taskInstance.outputSchema(), {
          ChatTaskRow,
          StreamingTextRow,
          DefaultTaskRow,
        });
        return (
          <Row
            key={t.id}
            task={taskInstance}
            line={t}
            nodeKey={`/${t.id}`}
            iterationSlots={iterationSlots.get(t.id)}
          />
        );
      })}
      {afterLine ? <Text dimColor>{afterLine}</Text> : null}
    </Box>
  );
}
