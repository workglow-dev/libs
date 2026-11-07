/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, StreamEvent } from "@workglow/task-graph";
import { GraphAsTask, Task, TaskGraph } from "@workglow/task-graph";
import { setLogger, sleep } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

setLogger(getTestingLogger());

/** Streams one delta, then waits for an abort or fails `failAfterMs` later. */
class SlowStreamingChild extends Task<Record<string, unknown>, { text: string }> {
  public static override type = "SlowStreamingChild";
  public static override cacheable = false;
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: true } as const;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string", "x-stream": "append" } },
    } as const satisfies DataPortSchema;
  }
  public static aborted = false;
  public static failAfterMs = 50;

  async *executeStream(
    _input: Record<string, unknown>,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<{ text: string }>> {
    yield { type: "text-delta", port: "text", textDelta: "a" };
    const signal = context.signal;
    await Promise.race([
      sleep(SlowStreamingChild.failAfterMs),
      new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
    ]);
    if (signal?.aborted) {
      SlowStreamingChild.aborted = true;
      return;
    }
    throw new Error("child failed after the consumer left");
  }
}

describe("GraphAsTask.executeStream when the consumer stops early", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    SlowStreamingChild.aborted = false;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  async function readOneEventThenLeave(): Promise<void> {
    const subGraph = new TaskGraph();
    subGraph.addTask(new SlowStreamingChild({ id: "child" }));
    const group = new GraphAsTask({ subGraph });
    const stream = group
      .executeStream({}, {
        signal: new AbortController().signal,
      } as IExecuteContext)
      [Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "text-delta", textDelta: "a" });
    await stream.return?.(undefined);
  }

  it("stops the subgraph it started", async () => {
    SlowStreamingChild.failAfterMs = 2_000;
    await readOneEventThenLeave();
    await sleep(100);
    expect(SlowStreamingChild.aborted).toBe(true);
  });

  it("does not leave the subgraph's failure as an unhandled rejection", async () => {
    SlowStreamingChild.failAfterMs = 20;
    await readOneEventThenLeave();
    await sleep(200);
    expect(unhandled).toEqual([]);
  });
});
