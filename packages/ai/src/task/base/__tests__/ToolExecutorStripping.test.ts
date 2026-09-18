/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "vitest";

import { withoutToolExecutors } from "../AiTask";

const toolWithExecutor = {
  name: "build_workflow",
  description: "Builds a workflow",
  inputSchema: { type: "object", properties: {} },
  execute: async () => "done",
};

describe("withoutToolExecutors", () => {
  test("drops `execute` so the job input survives structured clone", () => {
    // The real failure this guards: a worker-backed provider posts the job
    // input to its worker, and `postMessage` throws `DataCloneError` on a
    // function — taking the whole agent turn down with it.
    const input = { model: "m1", prompt: "hi", tools: [toolWithExecutor] };
    expect(() => structuredClone(input)).toThrow();

    const stripped = withoutToolExecutors(input);
    expect(() => structuredClone(stripped)).not.toThrow();
    expect(stripped.tools[0]).not.toHaveProperty("execute");
  });

  test("keeps every model-facing field of the definition", () => {
    const stripped = withoutToolExecutors({
      model: "m1",
      tools: [{ ...toolWithExecutor, taskType: "BuildTask" }],
    });
    expect(stripped.tools[0]).toEqual({
      name: "build_workflow",
      description: "Builds a workflow",
      inputSchema: { type: "object", properties: {} },
      taskType: "BuildTask",
    });
  });

  test("does not mutate the caller's input — the host still owns its executors", () => {
    const tools = [toolWithExecutor];
    const input = { model: "m1", tools };
    withoutToolExecutors(input);
    expect(typeof tools[0].execute).toBe("function");
    expect(input.tools).toBe(tools);
  });

  test("returns the same object when there is nothing to strip", () => {
    const input = { model: "m1", tools: [{ name: "t", description: "d", inputSchema: {} }] };
    expect(withoutToolExecutors(input)).toBe(input);
    const noTools = { model: "m1", prompt: "hi" };
    expect(withoutToolExecutors(noTools)).toBe(noTools);
  });

  test("leaves a non-array `tools` value alone", () => {
    const input = { model: "m1", tools: "auto" };
    expect(withoutToolExecutors(input)).toBe(input);
  });
});
