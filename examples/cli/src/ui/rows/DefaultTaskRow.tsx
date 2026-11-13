/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from "ink";
import React from "react";
import { TaskErrorDetail } from "../components/TaskErrorDetail";
import { TaskStatusProgressRow } from "../components/TaskStatusProgressRow";
import { concurrencyLimitOf, isIteratorTask } from "../model/iteratorTask";
import type { CliTaskLine } from "../taskGraphCliSubscriptions";
import type { TaskRowProps } from "./pickRenderer";
import { isRedundantSubgraph, IterationTaskRows, SubtaskRows } from "./SubtaskRows";
import { settledTaskDurationMs } from "./taskDuration";
import { useSubtaskRows } from "./useSubtaskRows";
import { useTaskUsageLine } from "./useTaskUsageLine";

export function DefaultTaskRow({
  task,
  line,
  iterationSlots,
  nodeKey,
}: TaskRowProps): React.ReactElement {
  const subtasks = useSubtaskRows(task);
  const usageLine = useTaskUsageLine(task);
  const iterator = isIteratorTask(task);
  return (
    <Box key={line.id} flexDirection="column">
      <TaskStatusProgressRow
        label={line.label}
        status={line.status}
        message={line.message}
        barProgress={line.progress}
        durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
      />
      {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      <TaskErrorDetail task={task} status={line.status} />
      <IterationTaskRows
        task={task}
        nodeKey={nodeKey}
        slots={iterationSlots}
        concurrencyLimit={concurrencyLimitOf(task)}
      />
      {!iterator && !isRedundantSubgraph(subtasks.rows, line.type) && (
        <SubtaskRows
          listKey={nodeKey}
          rows={subtasks.rows}
          tasks={subtasks.tasks}
          iterationSlots={subtasks.iterationSlots}
        />
      )}
    </Box>
  );
}

export type { CliTaskLine };
