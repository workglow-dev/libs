/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatUsage } from "@workglow/ai";
import type { ITask, StreamEvent, Usage } from "@workglow/task-graph";
import { retractText, TaskStatus } from "@workglow/task-graph";
import { ArrayTask } from "@workglow/tasks";
import type { Node, NodeProps } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { FiCloud, FiCloudLightning } from "react-icons/fi";
import { ProgressBar } from "../components/ProgressBar";
import { TaskDataButtons } from "../components/TaskDataButtons";
import { NodeContainer } from "./NodeContainer";
import { NodeHeader } from "./NodeHeader";

export type TaskNodeData = {
  task: ITask;
  /** This node's cumulative token total for the current run. */
  usage?: Usage | undefined;
};

/**
 * Calculate consolidated progress from subtasks if available, otherwise use task's own progress
 */
function calculateConsolidatedProgress(task: ITask): number {
  if (task.hasChildren()) {
    const tasks = task.subGraph.getTasks();
    if (tasks.length > 0) {
      const totalProgress = tasks.reduce((acc, t) => acc + (t.progress ?? 0), 0);
      return Math.round(totalProgress / tasks.length);
    }
  }
  return task.progress ?? 0;
}

export function TaskNode(props: NodeProps<Node<TaskNodeData, string>>) {
  const { data, isConnectable } = props;
  const [status, setStatus] = useState<TaskStatus>(data.task.status);
  const [progress, setProgress] = useState<number | undefined>(
    calculateConsolidatedProgress(data.task)
  );
  const [progressMessage, setProgressMessage] = useState<string | undefined>(undefined);
  const [subTasks, setSubTasks] = useState<ITask[]>([]);
  const [isExpanded, setIsExpanded] = useState(data.task instanceof ArrayTask);
  const [isExpandable, setIsExpandable] = useState(false);
  const [streamingText, setStreamingText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const streamingTextRef = useRef<string>("");
  const [reasoningText, setReasoningText] = useState<string>("");
  const reasoningTextRef = useRef<string>("");
  const task = data.task;
  const [trackedTask, setTrackedTask] = useState(task);
  if (trackedTask !== task) {
    setTrackedTask(task);
    setStatus(task.status);
    setProgress(calculateConsolidatedProgress(task));
    setProgressMessage(undefined);
    setSubTasks(task.hasChildren() ? task.subGraph.getTasks() : []);
    setIsExpandable(task.hasChildren());
    // What the previous task streamed is not this one's, and this one may have
    // started streaming before the effect below subscribes to it.
    setIsStreaming(false);
    setStreamingText("");
    setReasoningText("");
  }

  useEffect(() => {
    const unsubscribes: (() => void)[] = [];
    streamingTextRef.current = "";
    reasoningTextRef.current = "";

    // Helper to update consolidated progress
    const updateConsolidatedProgress = () => {
      setProgress(calculateConsolidatedProgress(task));
    };

    unsubscribes.push(
      task.subscribe("status", () => {
        setStatus(task.status);
        updateConsolidatedProgress();
      })
    );

    unsubscribes.push(
      task.subscribe("progress", (newProgress, newMessage) => {
        if (task.hasChildren()) {
          // For tasks with subgraphs, keep using consolidated progress (always numeric).
          setProgress(calculateConsolidatedProgress(task));
        } else {
          // For leaf tasks, use the reported progress directly (may be undefined = indeterminate).
          setProgress(newProgress);
        }
        setProgressMessage(newMessage);
      })
    );

    unsubscribes.push(
      task.subscribe("stream_start", () => {
        setIsStreaming(true);
        setStreamingText("");
        streamingTextRef.current = "";
        setReasoningText("");
        reasoningTextRef.current = "";
      })
    );

    unsubscribes.push(
      task.subscribe("stream_chunk", (event: StreamEvent) => {
        if (event.type === "text-delta") {
          // A model's thinking streams beside its answer on its own port; every
          // other port, a missing one included, is what the task is saying.
          if (event.port === "reasoning") {
            reasoningTextRef.current += event.textDelta;
            setReasoningText(reasoningTextRef.current);
          } else {
            streamingTextRef.current += event.textDelta;
            setStreamingText(streamingTextRef.current);
          }
        } else if (event.type === "text-retract") {
          // A failed attempt takes back what it streamed, from the same port.
          const keep = (text: string): string => retractText(text, event.length);
          if (event.port === "reasoning") {
            reasoningTextRef.current = keep(reasoningTextRef.current);
            setReasoningText(reasoningTextRef.current);
          } else {
            streamingTextRef.current = keep(streamingTextRef.current);
            setStreamingText(streamingTextRef.current);
          }
        } else if (event.type === "snapshot") {
          const text = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
          streamingTextRef.current = text;
          setStreamingText(text);
        }
      })
    );

    unsubscribes.push(
      task.subscribe("stream_end", () => {
        setIsStreaming(false);
      })
    );

    // Wired unconditionally, not behind `hasChildren()`: a task typically owns
    // its first child partway through `execute()`, long after this effect ran,
    // and the effect never re-runs because `task.subGraph` is created once and
    // kept. Gating here would leave dynamically-owned subtasks unsubscribed.
    //
    // Keyed by subtask id rather than appended to `unsubscribes`, so a subtask
    // released with `context.disown` can actually be dropped. An append-only
    // list would retain every subtask the subgraph ever held — and a reused
    // instance owned again would stack a second pair of subscriptions, so an
    // own/disown loop over N jobs would recompute progress N times per event.
    const subTaskUnsubs = new Map<string, () => void>();

    const wireSubTask = (subTask: ITask): void => {
      const id = String(subTask.id);
      if (subTaskUnsubs.has(id)) return;
      const unsubs = [
        subTask.subscribe("progress", updateConsolidatedProgress),
        subTask.subscribe("status", updateConsolidatedProgress),
      ];
      subTaskUnsubs.set(id, () => {
        for (const u of unsubs) u();
      });
    };

    for (const subTask of task.subGraph.getTasks()) {
      wireSubTask(subTask);
    }

    unsubscribes.push(
      task.subGraph.subscribe("task_added", (taskId) => {
        setSubTasks(task.subGraph.getTasks());
        setIsExpandable(true);
        // The added task, not whatever sorts last: re-adding a disowned
        // instance moves it to the tail, so `getTasks()[length - 1]` would
        // re-subscribe an already-wired task.
        const added = task.subGraph.getTask(taskId);
        if (added) wireSubTask(added);
        updateConsolidatedProgress();
      })
    );

    unsubscribes.push(
      task.subGraph.subscribe("task_removed", (taskId) => {
        const id = String(taskId);
        subTaskUnsubs.get(id)?.();
        subTaskUnsubs.delete(id);
        setSubTasks(task.subGraph.getTasks());
        setIsExpandable(task.hasChildren());
        updateConsolidatedProgress();
      })
    );

    unsubscribes.push(() => {
      for (const u of subTaskUnsubs.values()) u();
      subTaskUnsubs.clear();
    });

    unsubscribes.push(
      task.subscribe("regenerate", () => {
        setSubTasks(task.subGraph.getTasks());
        updateConsolidatedProgress();
      })
    );

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [task, task.subGraph]);

  return (
    <>
      <NodeContainer isConnectable={isConnectable} status={status}>
        <NodeHeader
          title={data.task.type}
          description={data.task.config?.title || ""}
          status={status}
        />
        {formatUsage(data.usage, "cumulative") ? (
          <span className="task-node-usage">{formatUsage(data.usage, "cumulative")}</span>
        ) : null}
        <TaskDataButtons task={data.task} />
        <ProgressBar
          progress={progress}
          status={status}
          showText={true}
          message={progressMessage}
        />

        {(isStreaming || (status === TaskStatus.STREAMING && (streamingText || reasoningText))) && (
          <div className="mt-2 p-2 bg-[rgba(28,35,50,0.6)] rounded-sm text-xs font-mono max-h-24 overflow-y-auto">
            <div className="flex items-center gap-1 mb-1">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-streaming-pulse" />
              <span className="text-blue-400 text-[10px]">Streaming</span>
            </div>
            {reasoningText && (
              <details className="task-node-reasoning mb-1 text-gray-500 italic">
                <summary className="cursor-pointer text-[10px] select-none">Thinking</summary>
                <pre className="whitespace-pre-wrap break-words text-[11px] max-h-16 overflow-y-auto">
                  {reasoningText}
                </pre>
              </details>
            )}
            <pre className="whitespace-pre-wrap text-gray-300 break-words">{streamingText}</pre>
          </div>
        )}

        {isExpandable && (
          <div className="flex items-center justify-between mt-3 mb-1">
            <div className="text-xs font-semibold">
              {data.task instanceof ArrayTask ? "Array" : "Graph"} Task
            </div>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs bg-gray-800 hover:bg-gray-700 rounded-sm px-2 py-0.5 transition-colors"
            >
              {isExpanded ? "Hide" : "Show"} sub-graph
            </button>
          </div>
        )}
        {/* Sub-tasks progress */}
        {isExpanded && (
          <div className="mt-3">
            <div className="text-xs font-semibold mb-2">
              <span className="text-gray-500 ml-2">
                {subTasks.filter((t) => t.status === TaskStatus.COMPLETED).length}/{subTasks.length}{" "}
                completed
              </span>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {subTasks.map((subTask) => (
                <SubTask key={subTask.id as string} subTask={subTask} />
              ))}
            </div>
          </div>
        )}
      </NodeContainer>
      <div className="cloud gradient">
        <div>
          {data.task.status === TaskStatus.PROCESSING ||
          data.task.status === TaskStatus.STREAMING ? (
            <FiCloudLightning />
          ) : (
            <FiCloud />
          )}
        </div>
      </div>
    </>
  );
}

function SubTask({ subTask }: { subTask: ITask }) {
  const [progress, setProgress] = useState<number>(subTask.progress ?? 0);
  const [progressMessage, setProgressMessage] = useState<string>("");
  const [status, setStatus] = useState<TaskStatus>(subTask.status);
  const [progressDetails, setProgressDetails] = useState<Array<{ file: string; progress: number }>>(
    []
  );

  const [prevSubTask, setPrevSubTask] = useState(subTask);
  if (prevSubTask !== subTask) {
    setPrevSubTask(subTask);
    setProgress(subTask.progress ?? 0);
    setStatus(subTask.status);
  }

  useEffect(() => {
    const unsubscribes: (() => void)[] = [];

    unsubscribes.push(
      subTask.subscribe("start", () => {
        setProgressDetails([]);
        setProgressMessage("");
        setProgress(0);
      })
    );

    unsubscribes.push(
      subTask.subscribe("status", () => {
        setStatus(subTask.status);
        setProgress(subTask.progress ?? 0);
        if (subTask.status === TaskStatus.COMPLETED && subTask.runOutputData.text) {
          setProgressMessage(subTask.runOutputData.text as string);
        }
      })
    );

    unsubscribes.push(
      subTask.subscribe("progress", (progress, message, details) => {
        setProgress(progress ?? 0);
        setProgressMessage(details?.text || details?.file || message);

        // Track file-based progress details
        if (details?.file) {
          setProgressDetails((oldDetails) => {
            const fileProgress = details.progress ?? progress;
            // Remove files that have reached 100%
            const filteredDetails = (oldDetails ?? []).filter((d) => d.progress < 100);

            // If this file is at 100%, don't add it back
            if (fileProgress >= 100) {
              return filteredDetails;
            }

            if (filteredDetails.length === 0) {
              return [{ file: details.file, progress: fileProgress }];
            }
            const found = filteredDetails.find((d) => d.file === details.file);
            if (found) {
              return filteredDetails.map((d) =>
                d.file === details.file ? { file: details.file, progress: fileProgress } : d
              );
            }
            return [...filteredDetails, { file: details.file, progress: fileProgress }];
          });
        }
      })
    );

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [subTask]);

  // Calculate overall progress from all files or use single progress
  const overallProgress =
    progressDetails.length > 0
      ? progressDetails.reduce((sum, d) => sum + d.progress, 0) / progressDetails.length
      : progress;

  const hasFileProgress = progressDetails.length > 0;

  return (
    <div key={subTask.id as string} className="text-xs subtask-progress">
      {hasFileProgress ? (
        <>
          {/* Overall progress section - only show when there are multiple files */}
          <div className="mb-2">
            <div className="flex justify-between mb-1">
              <span className="truncate font-semibold">Overall Progress</span>
              <span className="text-gray-500">{Math.round(overallProgress || 0)}%</span>
            </div>
            <div className="progress-container">
              <ProgressBar progress={overallProgress || 0} status={status} showText={false} />
            </div>
          </div>

          {/* Individual file progress details */}
          <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-gray-700">
            {progressDetails.map((detail) => (
              <div key={detail.file} className="text-xs">
                <div className="flex justify-between mb-0.5">
                  <span className="truncate text-gray-400">{detail.file}</span>
                  <span className="text-gray-500">{Math.round(detail.progress || 0)}%</span>
                </div>
                <div className="progress-container">
                  <ProgressBar progress={detail.progress || 0} status={status} showText={false} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        /* Single progress bar when there's only one message stream */
        <div>
          <div className="flex justify-between mb-1">
            <span className="truncate">{progressMessage || "Progress"}</span>
            <span className="text-gray-500">{Math.round(progress || 0)}%</span>
          </div>
          <div className="progress-container">
            <ProgressBar progress={progress || 0} status={status} showText={false} />
          </div>
        </div>
      )}
    </div>
  );
}
