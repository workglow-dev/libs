/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRunConfig, ITask } from "@workglow/task-graph";
import { Box, Static, Text, useWindowSize } from "ink";
import path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { adoptPolledProgress, startTaskInstancePoll, type TaskFileProgressRow } from "./cliTaskUi";
import { useCliTheme } from "./CliThemeContext";
import { CLI_SPINNER_FRAMES } from "./components/CliSpinner";
import { ProgressBar } from "./components/ProgressBar";
import { deriveRunState, RunStatusBar } from "./components/RunStatusBar";
import { RunViewportProvider } from "./components/RunViewport";
import { ScrollRegion } from "./components/ScrollRegion";
import { StreamOutput } from "./components/StreamOutput";
import { TaskErrorDetail } from "./components/TaskErrorDetail";
import { TaskStatusProgressRow } from "./components/TaskStatusProgressRow";
import { HumanInteractionHost } from "./HumanInteractionHost";
import { planRunViewport } from "./model/runViewport";
import { isRedundantSubgraph, SubtaskRows } from "./rows/SubtaskRows";
import { settledTaskDurationMs } from "./rows/taskDuration";
import { useSubtaskRows } from "./rows/useSubtaskRows";
import { useTaskUsageLine } from "./rows/useTaskUsageLine";
import { cliTaskLabel } from "./taskGraphCliSubscriptions";
import { useGraphUsageLine } from "./useGraphUsageLine";
import { useRepaintOnResize } from "./useRepaintOnResize";
import { useTaskRunCensus } from "./useRunCensus";
import { useRunClock } from "./useRunClock";

interface TaskRunAppProps {
  readonly task: ITask;
  readonly taskType: string;
  readonly overrides?: Record<string, unknown>;
  readonly runConfig?: Partial<IRunConfig>;
  readonly onComplete: (result: unknown) => void;
  readonly onError: (error: Error) => void;
}

interface LogLine {
  readonly id: number;
  readonly text: string;
}

/** Batched progress UI when there is no per-file download list (keeps Ink calm). */
interface TaskRunDisplayBatch {
  readonly spin: number;
  readonly progress: number | undefined;
  readonly message: string | undefined;
}

const SPINNER_MOD = CLI_SPINNER_FRAMES.length;

function mapTaskFiles(task: unknown): TaskFileProgressRow[] {
  const t = task as { files?: TaskFileProgressRow[] };
  return Array.isArray(t.files) ? t.files.map((f) => ({ file: f.file, progress: f.progress })) : [];
}

function fileListsEqual(
  a: readonly TaskFileProgressRow[],
  b: readonly TaskFileProgressRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].file !== b[i].file || a[i].progress !== b[i].progress) return false;
  }
  return true;
}

/** Matches per-file {@link ProgressBar} width in download mode. */
const DOWNLOAD_PROGRESS_BAR_WIDTH = 10;

/** Footer, its rule, and a blank line before the shell prompt. */
const RESERVED_ROWS = 3;

/** A region smaller than this shows nothing useful; better to overflow the window. */
const MIN_REGION_ROWS = 4;

export function TaskRunApp({
  task,
  taskType,
  overrides,
  runConfig,
  onComplete,
  onError,
}: TaskRunAppProps): React.ReactElement {
  const theme = useCliTheme();
  const bodyColor = theme.level === "advanced" ? theme.fg : undefined;
  const [status, setStatus] = useState("PENDING");
  const progressRef = useRef({
    prog: undefined as number | undefined,
    msg: undefined as string | undefined,
  });
  const [batch, setBatch] = useState<TaskRunDisplayBatch>({
    spin: 0,
    progress: undefined,
    message: undefined,
  });
  const [downloadFiles, setDownloadFiles] = useState<TaskFileProgressRow[]>([]);
  const [streamText, setStreamText] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const runUsageLine = useGraphUsageLine(task.subGraph);
  const subtasks = useSubtaskRows(task);
  const usageLine = useTaskUsageLine(task);
  const census = useTaskRunCensus(task);
  const elapsedMs = useRunClock(
    status !== "COMPLETED" && status !== "FAILED" && status !== "ABORTED"
  );
  // Ink re-reads this on every SIGWINCH, so a resized window re-prices the
  // plan on the next frame.
  const windowSize = useWindowSize();
  useRepaintOnResize(windowSize.columns);
  const budgetRows = Math.max(MIN_REGION_ROWS, windowSize.rows - RESERVED_ROWS);
  const plan = useMemo(() => planRunViewport(census.tree, budgetRows), [census.tree, budgetRows]);

  const showFileDownloadList = downloadFiles.length > 0;
  /** One header row + optional file list — avoids a pre-files row (default bar width) then a second row after `files` appears. */
  const isModelDownloadTask = taskType === "ModelDownloadTask";

  useEffect(() => {
    let logCounter = 0;

    const flushTaskDisplay = (): void => {
      const fileList = mapTaskFiles(task);
      const prog = adoptPolledProgress(task.progress, progressRef.current.prog);
      const msg = progressRef.current.msg;
      if (fileList.length > 0) {
        setDownloadFiles((prev) => (fileListsEqual(prev, fileList) ? prev : fileList));
        setBatch((prev) => ({
          spin: (prev.spin + 1) % SPINNER_MOD,
          progress: prog,
          message: msg,
        }));
        return;
      }
      setDownloadFiles([]);
      setBatch((prev) => ({
        spin: (prev.spin + 1) % SPINNER_MOD,
        progress: prog,
        message: msg,
      }));
    };

    task.events.on("status", (newStatus: string) => {
      setStatus(newStatus);
    });

    task.events.on("progress", (prog: number | undefined, msg?: string) => {
      if (prog !== undefined) progressRef.current.prog = prog;
      if (msg) progressRef.current.msg = msg;
    });

    // `textDelta`, not `text`: that is the field name on StreamTextDelta, and
    // the loose local type here is why reading the wrong one showed as an
    // empty panel rather than as a compile error.
    task.events.on("stream_chunk", (event: { type: string; textDelta?: string }) => {
      if (event.type === "text-delta" && event.textDelta) {
        setStreamText((prev) => prev + event.textDelta);
      }
    });

    task.events.on("stream_end", () => {
      setStreamText((prev) => {
        if (prev) {
          setLogs((logs) => [...logs, { id: logCounter++, text: prev }]);
        }
        return "";
      });
    });

    const stopPollTask = startTaskInstancePoll(() => task, setStatus);

    flushTaskDisplay();
    /** 200ms batches high-frequency download updates so Ink stays responsive. */
    const displayInterval = setInterval(flushTaskDisplay, 200);

    task
      .run(overrides, runConfig)
      .then((result) => onComplete(result))
      .catch((err) => onError(err));

    return () => {
      clearInterval(displayInterval);
      stopPollTask();
    };
  }, [onComplete, onError, task, taskType, overrides, runConfig]);

  /** Job queue may register multiple subgraph tasks of the same type (mirrors); hide when all match the parent. */
  const subgraphIsAllSameTypeMirror =
    isModelDownloadTask &&
    subtasks.rows.length > 1 &&
    subtasks.rows.every((t) => t.type === taskType);
  /** Per-file download UI already reflects progress; subgraph rows duplicate the parent row (often another ModelDownloadTask). */
  const hideSubtasksWhileDownloadFileUi = isModelDownloadTask && showFileDownloadList;
  const showSubtasksSection =
    !hideSubtasksWhileDownloadFileUi &&
    !isRedundantSubgraph(subtasks.rows, taskType) &&
    !subgraphIsAllSameTypeMirror;

  return (
    <HumanInteractionHost>
      <Box flexDirection="column">
        <Static items={logs}>
          {(log) => (
            <Text key={log.id} color={bodyColor}>
              {log.text}
            </Text>
          )}
        </Static>

        <RunViewportProvider
          plan={plan}
          slot={
            <ScrollRegion budgetRows={budgetRows}>
              <Box flexDirection="column">
                <TaskStatusProgressRow
                  label={cliTaskLabel(task)}
                  status={status}
                  message={isModelDownloadTask ? undefined : batch.message}
                  barProgress={batch.progress}
                  durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
                  spinnerFrame={batch.spin}
                  progressBarWidth={isModelDownloadTask ? DOWNLOAD_PROGRESS_BAR_WIDTH : undefined}
                />
                {usageLine ? <Text dimColor> {usageLine}</Text> : null}
                <TaskErrorDetail task={task} status={status} />
                {showFileDownloadList && (
                  <Box paddingLeft={2} flexDirection="column">
                    {downloadFiles.map((f) => (
                      <Box key={f.file} flexDirection="row" flexWrap="nowrap" alignItems="center">
                        <Box flexGrow={1} minWidth={0} overflow="hidden" marginRight={1}>
                          <Text dimColor wrap="truncate-end">
                            {path.basename(f.file)}
                          </Text>
                        </Box>
                        <Box flexShrink={0}>
                          <ProgressBar progress={f.progress} width={DOWNLOAD_PROGRESS_BAR_WIDTH} />
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}
                {streamText && <StreamOutput text={streamText} />}
                {showSubtasksSection && (
                  <SubtaskRows
                    listKey={`/${String(task.id)}`}
                    rows={subtasks.rows}
                    tasks={subtasks.tasks}
                    iterationSlots={subtasks.iterationSlots}
                    overallProgress={subtasks.overallProgress}
                    variant="chrome"
                  />
                )}
              </Box>
            </ScrollRegion>
          }
        />
        <RunStatusBar
          usageLine={runUsageLine}
          counts={census.counts}
          state={deriveRunState([status])}
          elapsedMs={elapsedMs}
          hiddenRows={plan.hidden}
        />
      </Box>
    </HumanInteractionHost>
  );
}
