/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from "ink";
import React from "react";
import { TaskErrorDetail } from "../components/TaskErrorDetail";
import { StreamedReasoning } from "../components/StreamedReasoning";
import { TaskStatusProgressRow } from "../components/TaskStatusProgressRow";
import { STREAM_PANEL_MAX_LINES, tailLines, visibleReasoning } from "../model/streamedText";
import type { TaskRowProps } from "./pickRenderer";
import { settledTaskDurationMs } from "./taskDuration";
import { useTaskStreamText } from "./useTaskStreamText";
import { useTaskUsageLine } from "./useTaskUsageLine";

export function StreamingTextRow({ task, line }: TaskRowProps): React.ReactElement {
  const streamed = useTaskStreamText(task);
  const reasoning = visibleReasoning(streamed);
  const usageLine = useTaskUsageLine(task);
  // The first text-delta flips a task to STREAMING, so PROCESSING alone would
  // hide the panel for exactly the tasks that have something to show in it.
  const isActive = line.status === "PROCESSING" || line.status === "STREAMING";
  const showPanel = isActive && (streamed.text.length > 0 || reasoning.length > 0);

  return (
    <Box flexDirection="column">
      <TaskStatusProgressRow
        label={line.label}
        status={line.status}
        message={line.message}
        barProgress={line.progress}
        durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
      />
      {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      <TaskErrorDetail task={task} status={line.status} />
      {showPanel && (
        <Box
          flexDirection="column"
          marginTop={0}
          marginLeft={2}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {streamed.text.length > 0 ? (
            <Text dimColor>{tailLines(streamed.text, STREAM_PANEL_MAX_LINES)}</Text>
          ) : (
            <StreamedReasoning reasoning={reasoning} maxLines={STREAM_PANEL_MAX_LINES} />
          )}
        </Box>
      )}
    </Box>
  );
}
