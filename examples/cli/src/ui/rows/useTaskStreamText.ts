/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, StreamEvent } from "@workglow/task-graph";
import { useEffect, useState } from "react";
import { EMPTY_STREAMED_TEXT, foldTextDelta, type StreamedText } from "../model/streamedText";

/**
 * Subscribes to `stream_chunk` text-delta events on a task and returns the
 * accumulated answer and reasoning, kept apart by port. Clears on `stream_end`
 * or when the task status transitions to COMPLETED.
 */
export function useTaskStreamText(task: ITask): StreamedText {
  const [text, setText] = useState<StreamedText>(EMPTY_STREAMED_TEXT);

  useEffect(() => {
    const onChunk = (event: StreamEvent): void => {
      setText((prev) => foldTextDelta(prev, event));
    };
    const onEnd = (): void => {
      setText(EMPTY_STREAMED_TEXT);
    };
    const onStatus = (status: string): void => {
      if (status === "COMPLETED") setText(EMPTY_STREAMED_TEXT);
    };

    task.events.on("stream_chunk", onChunk);
    task.events.on("stream_end", onEnd);
    task.events.on("status", onStatus);

    return () => {
      task.events.off("stream_chunk", onChunk);
      task.events.off("stream_end", onEnd);
      task.events.off("status", onStatus);
    };
  }, [task]);

  return text;
}
