/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskGraph, Workflow } from "@workglow/task-graph";
import { InMemoryTaskOutputRepository } from "@workglow/task-graph/test";
import { lambda, LambdaTask } from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

describe("LambdaTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  test("in command mode", async () => {
    const results = await lambda(
      { data: null },
      {
        execute: async () => {
          return { output: "Hello, world!" };
        },
      }
    );
    expect(results).toEqual({ output: "Hello, world!" });
  });

  test("in task preview mode with input", async () => {
    // After the run/runPreview split, executePreview-only configs must be
    // invoked via runPreview(); demonstrate that contract directly.
    const task = new LambdaTask({
      defaults: { a: 1, b: 2 },
      executePreview: async (input) => {
        return { output: input.a + input.b };
      },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ output: 3 });
  });

  test("in task preview mode", async () => {
    const task = new LambdaTask({
      executePreview: async () => {
        return { output: "Hello, world!" };
      },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ output: "Hello, world!" });
  });

  test("in task graph preview mode", async () => {
    const graph = new TaskGraph();
    graph.addTask(
      new LambdaTask({
        id: "lambdaPreviewTest",
        executePreview: async () => {
          return { output: "Hello, world!" };
        },
      })
    );
    const results = await graph.runPreview();
    expect(results[0].data).toEqual({ output: "Hello, world!" });
  });

  test("in task workflow mode", async () => {
    const workflow = new Workflow();
    workflow.lambda(
      {},
      {
        execute: async () => {
          return { output: "Hello, world!" };
        },
      }
    );
    const results = await workflow.run();
    expect(results).toEqual({
      output: "Hello, world!",
    });
  });

  test("in task workflow mode with input execute", async () => {
    const workflow = new Workflow();
    workflow.lambda(
      {
        a: 1,
        b: 2,
      },
      {
        execute: async (input) => {
          return { output: input.a + input.b };
        },
      }
    );
    const results = await workflow.run();
    expect(results).toEqual({ output: 3 });
  });

  test("in task workflow mode with input executePreview returns empty from run()", async () => {
    // After the run/runPreview split, run() invokes execute() only. A LambdaTask
    // configured with only executePreview returns {} when run() is invoked.
    const workflow = new Workflow();
    workflow.lambda(
      {
        a: 1,
        b: 2,
      },
      {
        executePreview: async (input) => {
          return { output: input.a + input.b };
        },
      }
    );
    const results = await workflow.run();
    expect(results).toEqual({});
  });

  test("with updateProgress", async () => {
    const graph = new TaskGraph();
    const task = new LambdaTask({
      execute: async (_, { updateProgress }) => {
        void updateProgress(0.5, "Halfway there");
        return { output: "Hello, world!" };
      },
    });
    graph.addTask(task);
    let progressCounter = 0;
    task.on("progress", (progress: number | undefined) => {
      progressCounter++;
    });
    const results = await graph.run();
    expect(Array.isArray(results)).toBe(true);
    if (Array.isArray(results)) {
      expect(results[0].data).toEqual({ output: "Hello, world!" });
    }
    expect(progressCounter).toEqual(2); // manual updateProgress(0.5) + terminal-100 tick
  });

  test("keeps the run config it was constructed with", () => {
    // The constructor took only `config`, so a cache or any other run setting
    // passed as the second argument was dropped without a word.
    const runConfig = { cacheable: false, timeout: 1234 };
    const task = new LambdaTask({ execute: async () => ({}) }, runConfig as never);
    expect(task.runConfig).toMatchObject(runConfig);
  });

  test("never answers from the output cache: the function is not part of the key", async () => {
    // Keyed by type and input alone, two different lambdas sharing a cache returned
    // each other's results -- `square(3)` came back as `double(3)`.
    const cache = new InMemoryTaskOutputRepository();
    const double = new LambdaTask({ execute: async (i) => ({ out: Number(i.n) * 2 }) });
    const square = new LambdaTask({ execute: async (i) => ({ out: Number(i.n) * Number(i.n) }) });
    expect(await double.run({ n: 3 }, { outputCache: cache })).toEqual({ out: 6 });
    expect(await square.run({ n: 3 }, { outputCache: cache })).toEqual({ out: 9 });
  });
});
