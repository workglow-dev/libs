/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage, ContentBlock } from "@workglow/ai";
import type { ITask, StreamEvent } from "@workglow/task-graph";
import { Box, Text } from "ink";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { TaskErrorDetail } from "../components/TaskErrorDetail";
import { TaskStatusProgressRow } from "../components/TaskStatusProgressRow";
import type { TaskRowProps } from "./pickRenderer";
import { settledTaskDurationMs } from "./taskDuration";
import { useTaskUsageLine } from "./useTaskUsageLine";

const HISTORY_TAIL = 6;

function roleColor(role: ChatMessage["role"]): string | undefined {
  switch (role) {
    case "system":
      return undefined; // dim
    case "user":
      return "cyan";
    case "assistant":
      return "magenta";
    default:
      return "yellow";
  }
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "tool_use":
      return `[tool_use: ${block.name}]`;
    case "tool_result":
      return "[tool_result]";
    case "reasoning":
      // Kept for the model, not shown as part of the reply.
      return "";
  }
}

function messageText(message: ChatMessage): string {
  return (message.content as ReadonlyArray<ContentBlock>).map(blockToText).join("");
}

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];

function messagesFromTask(task: ITask): ReadonlyArray<ChatMessage> {
  return (task.runOutputData.messages as ReadonlyArray<ChatMessage> | undefined) ?? EMPTY_MESSAGES;
}

function subscribeToTaskMessages(task: ITask, onStoreChange: () => void): () => void {
  const onChunk = (event: StreamEvent): void => {
    if (event.type === "object-delta" && event.port === "messages") {
      onStoreChange();
    }
  };
  task.events.on("stream_chunk", onChunk);
  return () => {
    task.events.off("stream_chunk", onChunk);
  };
}

export function ChatTaskRow({ task, line }: TaskRowProps): React.ReactElement {
  // TaskRunner updates runOutputData before every object-delta; subscribe
  // so React always reads the authoritative accumulated history from the task.
  const messages = useSyncExternalStore(
    (onStoreChange) => subscribeToTaskMessages(task, onStoreChange),
    () => messagesFromTask(task),
    () => messagesFromTask(task)
  );
  // `streamText` is the in-progress assistant text for the *current* turn.
  // Appends on every text-delta; resets whenever history grows (meaning the
  // previous turn's assistant message just landed, or a new user turn has
  // started), and on stream_end.
  const [streamText, setStreamText] = useState("");
  const usageLine = useTaskUsageLine(task);

  useEffect(() => {
    const onChunk = (event: StreamEvent): void => {
      if (event.type === "text-delta") {
        const delta = (event as { textDelta?: string; text?: string }).textDelta ?? "";
        if (delta) setStreamText((prev) => prev + delta);
      } else if (event.type === "object-delta" && event.port === "messages") {
        // Each object-delta marks a turn boundary — clear the per-turn
        // streaming buffer so the next turn's text-deltas start fresh.
        setStreamText("");
      }
    };
    const onEnd = (): void => setStreamText("");
    task.events.on("stream_chunk", onChunk);
    task.events.on("stream_end", onEnd);
    return () => {
      task.events.off("stream_chunk", onChunk);
      task.events.off("stream_end", onEnd);
    };
  }, [task]);

  const status = line.status;

  if (status === "PENDING") {
    return (
      <Box flexDirection="column">
        <TaskStatusProgressRow
          label={line.label}
          status={status}
          message={line.message}
          barProgress={undefined}
        />
        {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      </Box>
    );
  }

  if (status === "COMPLETED") {
    return (
      <Box flexDirection="column">
        <TaskStatusProgressRow
          label={line.label}
          status={status}
          message={`${messages.length} messages`}
          barProgress={100}
          durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
        />
        {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      </Box>
    );
  }

  if (status === "FAILED") {
    return (
      <Box flexDirection="column">
        <TaskStatusProgressRow
          label={line.label}
          status={status}
          message={line.message ?? "failed"}
          barProgress={line.progress}
          durationMs={usageLine ? undefined : settledTaskDurationMs(task)}
        />
        {usageLine ? <Text dimColor> {usageLine}</Text> : null}
        <TaskErrorDetail task={task} status={status} />
      </Box>
    );
  }

  // PROCESSING
  const tail = messages.slice(Math.max(0, messages.length - HISTORY_TAIL));
  const showStreamingBubble = streamText.length > 0;

  return (
    <Box flexDirection="column">
      <TaskStatusProgressRow
        label={line.label}
        status={status}
        message={line.message}
        barProgress={line.progress}
      />
      {usageLine ? <Text dimColor> {usageLine}</Text> : null}
      <Box
        flexDirection="column"
        marginLeft={2}
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
      >
        {tail.map((m, i) => (
          <Box key={i} flexDirection="row">
            <Text color={roleColor(m.role)} bold>
              {m.role}:{" "}
            </Text>
            <Text color={roleColor(m.role)}>{messageText(m)}</Text>
          </Box>
        ))}
        {showStreamingBubble && (
          <Box flexDirection="row">
            <Text color="magenta" bold>
              assistant:{" "}
            </Text>
            <Text dimColor>{streamText}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
