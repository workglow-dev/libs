/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";
import { Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { render } from "ink";
import { EventEmitter } from "node:events";
import React from "react";
import { describe, expect, it } from "vitest";
import { WorkflowRunApp } from "../ui/WorkflowRunApp";

const OUTPUT = {
  type: "object",
  properties: {
    text: { type: "string", "x-stream": "append" },
    reasoning: { type: "string", "x-stream": "append" },
  },
} as const satisfies DataPortSchema;

const EMPTY = { type: "object", properties: {} } as const satisfies DataPortSchema;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Streams its thinking, pauses, then streams its answer, pausing after each. */
class ThinkingThenAnswerTask extends Task<Record<string, never>, { text: string }> {
  static override readonly type = "ThinkingThenAnswerTask";
  static override readonly title = "Thinking then answer";
  static override readonly category = "Test";
  static override readonly cacheable = false;
  static override inputSchema(): DataPortSchema {
    return EMPTY;
  }
  static override outputSchema(): DataPortSchema {
    return OUTPUT;
  }
  async *executeStream(): AsyncIterable<StreamEvent<{ text: string }>> {
    // Give the mounted row time to subscribe before the first delta.
    await sleep(300);
    yield { type: "text-delta", port: "reasoning", textDelta: "Weighing the options." };
    await sleep(400);
    yield { type: "text-delta", port: "text", textDelta: "The answer is 42." };
    await sleep(400);
    yield { type: "finish", data: {} as { text: string } };
  }
}

class CapturingStdout extends EventEmitter {
  readonly columns = 120;
  readonly rows = 40;
  readonly isTTY = true;
  readonly frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Z]/gi, "");

async function renderFrames(): Promise<string[]> {
  const workflow = new Workflow();
  workflow.pipe(new ThinkingThenAnswerTask() as never);
  const stdout = new CapturingStdout();
  let finished = false;
  const instance = render(
    React.createElement(WorkflowRunApp, {
      graph: workflow.graph,
      input: {},
      runExecutor: () => workflow.run({}),
      onComplete: () => {
        finished = true;
      },
      onError: () => {
        finished = true;
      },
    }),
    // Under a CI runner Ink would otherwise write only the final frame, and the
    // thinking this reads is drawn mid-run.
    { stdout: stdout as never, patchConsole: false, exitOnCtrlC: false, interactive: true }
  );
  const deadline = Date.now() + 6000;
  while (!finished && Date.now() < deadline) await sleep(20);
  await sleep(100);
  instance.unmount();
  return stdout.frames.map(stripAnsi);
}

describe("streaming row with a reasoning port", () => {
  it("draws thinking apart from the answer, and drops it once the answer starts", async () => {
    const frames = await renderFrames();

    const thinkingFrame = frames.find((f) => f.includes("Weighing the options."));
    expect(thinkingFrame, "reasoning was never drawn").toBeDefined();
    expect(thinkingFrame).toContain("thinking");
    expect(thinkingFrame).not.toContain("The answer is 42.");

    const answerFrame = frames.find((f) => f.includes("The answer is 42."));
    expect(answerFrame, "the answer was never drawn").toBeDefined();
    expect(answerFrame).not.toContain("Weighing the options.");
    expect(answerFrame).not.toContain("thinking");
  });
});
