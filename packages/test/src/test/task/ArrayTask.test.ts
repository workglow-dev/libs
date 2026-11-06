/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  ITask,
  TaskConfig,
  TaskInput,
  TaskOutput,
} from "@workglow/task-graph";
import {
  Dataflow,
  PROPERTY_ARRAY,
  Task,
  TaskConfigurationError,
  TaskGraph,
  TaskInvalidInputError,
  TaskStatus,
} from "@workglow/task-graph";
import { ArrayTask } from "@workglow/tasks";
import type { ConvertAllToOptionalArray } from "@workglow/util";
import { setLogger } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test, vi } from "vitest";

const spyOn = vi.spyOn;

// Define our input and output types
interface MultiplyInput extends TaskInput {
  a: number;
  b: number;
}

interface MultiplyOutput extends TaskOutput {
  result: number;
}

/**
 * Create a task that multiplies two numbers
 * This is a direct subclass of ArrayTask
 */
class MultiplyRunTask extends ArrayTask<
  ConvertAllToOptionalArray<MultiplyInput>,
  ConvertAllToOptionalArray<MultiplyOutput>,
  TaskConfig
> {
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        a: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
        b: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async execute(
    input: MultiplyInput,
    context: IExecuteContext
  ): Promise<MultiplyOutput> {
    // Simple multiplication - at this point, we know the inputs are not arrays
    return {
      result: input.a * input.b,
    };
  }
}
/**
 * Create a task that multiplies two numbers
 * This is a direct subclass of ArrayTask
 */
class MultiplyRunPreviewTask extends ArrayTask<
  ConvertAllToOptionalArray<MultiplyInput>,
  ConvertAllToOptionalArray<MultiplyOutput>
> {
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        a: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
        b: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async executePreview(input: MultiplyInput): Promise<MultiplyOutput> {
    return {
      result: input.a * input.b,
    };
  }
}

interface SquareInput extends TaskInput {
  a: number;
}
interface SquareOutput extends TaskOutput {
  result: number;
}

class SquareRunTask extends ArrayTask<
  ConvertAllToOptionalArray<SquareInput>,
  ConvertAllToOptionalArray<SquareOutput>
> {
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        a: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async execute(
    input: SquareInput,
    context: IExecuteContext
  ): Promise<SquareOutput> {
    return {
      result: input.a * input.a,
    };
  }
}

class SquareRunPreviewTask extends ArrayTask<
  ConvertAllToOptionalArray<SquareInput>,
  ConvertAllToOptionalArray<SquareOutput>
> {
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        a: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async executePreview(input: SquareInput): Promise<SquareOutput> {
    return {
      result: input.a * input.a,
    };
  }
}

interface JobQueueTestInput extends TaskInput {
  value: number;
}

interface JobQueueTestOutput extends TaskOutput {
  result: number;
}

class JobQueuePreviewTask extends Task<
  ConvertAllToOptionalArray<JobQueueTestInput>,
  ConvertAllToOptionalArray<JobQueueTestOutput>
> {
  public static override type = "JobQueuePreviewTask";

  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "number", default: 0 },
            { type: "array", items: { type: "number", default: 0 } },
          ],
          "x-replicate": true,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async executePreview(input: JobQueueTestInput): Promise<JobQueueTestOutput> {
    // Simple preview computation: double the value
    return {
      result: input.value * 2,
    };
  }
}

class JobQueuePreviewTask2 extends Task<JobQueueTestInput, JobQueueTestOutput> {
  public static override type = "JobQueuePreviewTask2";

  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        value: {
          type: "number",
          format: "int32",
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          type: "number",
          format: "int32",
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async executePreview(input: JobQueueTestInput): Promise<JobQueueTestOutput> {
    // Simple preview computation: double the value
    return {
      result: input.value * 2,
    };
  }
}

interface QueryTestInput extends TaskInput {
  query: string;
  val: number;
}

interface QueryTestOutput extends TaskOutput {
  result: string;
  val: number;
}

/**
 * Create a task that appends "-output" to a query string
 * Has one replicated input (query) and one normal input (val)
 */
class QueryAppendTask extends ArrayTask<
  ConvertAllToOptionalArray<QueryTestInput>,
  ConvertAllToOptionalArray<QueryTestOutput>,
  TaskConfig
> {
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        query: {
          oneOf: [
            { type: "string", default: "" },
            { type: "array", items: { type: "string", default: "" } },
          ],
          "x-replicate": true,
        },
        val: {
          type: "number",
          default: 0,
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        result: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        val: {
          type: "number",
        },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override async execute(input: QueryTestInput): Promise<QueryTestOutput> {
    return {
      result: `${input.query}-output`,
      val: input.val,
    };
  }

  public override async executePreview(input: QueryTestInput): Promise<QueryTestOutput> {
    const output = this.runOutputData;
    return {
      result: `${output.result ?? input.query}-preview`,
      val: input.val,
    };
  }

  /**
   * Override merge to keep non-replicated properties (val) as single values
   */
  public override executeMerge(input: QueryTestInput, output: QueryTestOutput): QueryTestOutput {
    output.val = input.val;
    return output;
  }
}

describe("ArrayTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  test("MultiplyRunTask in task mode run plain", async () => {
    const task = new MultiplyRunTask({
      maxIterations: 100,
      defaults: { a: 4, b: 5 },
    });
    // `executeTaskChildren` is protected; Vitest 5's `spyOn` overloads reach it
    // without a suppression, so the `@ts-expect-error` that used to sit here is
    // now itself an error under `tsc`.
    // For plain tasks (not array mode), executeTaskChildren should not be called
    const executeTaskChildrenSpy = spyOn(task.runner, "executeTaskChildren");
    const results = await task.run();
    expect(results).toEqual({ result: 20 });
    expect(executeTaskChildrenSpy).not.toHaveBeenCalled();
  });

  test("MultiplyRunTask in task mode run array", async () => {
    const task = new MultiplyRunTask({
      maxIterations: 100,
      defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], b: 1 },
    });
    const results = await task.run();
    expect(results).toEqual({ result: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  });

  test("MultiplyRunTask in task mode run array x array", async () => {
    const task = new MultiplyRunTask({
      maxIterations: 100,
      defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], b: [1, 2] },
    });
    const results = await task.run();
    expect(results).toEqual({
      result: [0, 0, 1, 2, 2, 4, 3, 6, 4, 8, 5, 10, 6, 12, 7, 14, 8, 16, 9, 18, 10, 20],
    });
  });

  test("MultiplyRunTask in task mode preview run", async () => {
    const task = new MultiplyRunTask({
      maxIterations: 100,
      id: "test",
      defaults: {
        a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        b: 10,
      },
    });
    {
      // const results = await task.runPreview();
      // expect(results).toEqual({} as any);
    }
    {
      await task.run();
      const results = await task.runPreview();
      expect(results).toEqual({ result: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] });
    }
  });

  test("MultiplyRunPreviewTask in task mode preview run", async () => {
    const task = new MultiplyRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 2, b: 10 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: 20 });
  });

  test("MultiplyRunPreviewTask in task mode preview runPreview", async () => {
    const task = new MultiplyRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 2, b: 10 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: 20 });
  });

  test("MultiplyRunPreviewTask in task mode preview runPreview array", async () => {
    const task = new MultiplyRunPreviewTask({
      maxIterations: 100,
      defaults: { a: [2], b: [10] },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: 20 });
  });

  test("MultiplyRunPreviewTask in task mode preview runPreview", async () => {
    const task = new MultiplyRunPreviewTask({
      maxIterations: 100,
      defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], b: 10 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] });
  });

  test("SquareRunTask in task mode run with single", async () => {
    const task = new SquareRunTask({
      maxIterations: 100,
      defaults: { a: 5 },
    });
    await task.run();
    const results = await task.runPreview();
    expect(results).toEqual({ result: 25 });
  });

  test("SquareRunTask in task mode preview run with single", async () => {
    const task = new SquareRunTask({
      maxIterations: 100,
      defaults: { a: 5 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({} as SquareOutput);
  });

  test("SquareRunPreviewTask in task mode run with single", async () => {
    const task = new SquareRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 5 },
    });
    await task.run();
    const results = await task.runPreview();
    expect(results).toEqual({ result: 25 });
  });

  test("SquareRunPreviewTask in task mode preview run with single", async () => {
    const task = new SquareRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 5 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: 25 } as SquareOutput);
  });

  test("ArrayTask runPreview calls executePreview in single task mode (no children)", async () => {
    // Create a task with non-array input - this puts it in single task mode (no subtasks)
    const task = new SquareRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 7 },
    });

    // Verify it has no children (single task mode)
    expect(task.hasChildren()).toBe(false);

    // Spy on executePreview to verify it's called
    const executePreviewSpy = spyOn(task, "executePreview");

    // Call runPreview without calling run() first
    const results = await task.runPreview();

    // Verify executePreview was actually called
    expect(executePreviewSpy).toHaveBeenCalledTimes(1);
    expect(executePreviewSpy).toHaveBeenCalledWith(
      { a: 7 },
      expect.objectContaining({ own: expect.any(Function) })
    );

    // Verify the result is correct (executePreview should have computed it)
    expect(results).toEqual({ result: 49 }); // 7 * 7 = 49
  });

  test("ArrayTask runPreview works in single task mode without prior run() call", async () => {
    // This test ensures runPreview works even when run() hasn't been called first
    const task = new MultiplyRunPreviewTask({
      maxIterations: 100,
      defaults: { a: 3, b: 4 },
    });

    // Verify single task mode
    expect(task.hasChildren()).toBe(false);

    // Call runPreview without calling run() first
    const results = await task.runPreview();

    // Should compute the result using executePreview
    expect(results).toEqual({ result: 12 }); // 3 * 4 = 12
    expect(task.runOutputData).toEqual({ result: 12 });
  });

  test("in task mode non-preview run", async () => {
    const task = new SquareRunTask({
      maxIterations: 100,
      defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    });
    const results = await task.run();
    expect(results).toEqual({ result: [0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100] });
  });

  test("in task mode non-preview runPreview", async () => {
    const task = new SquareRunPreviewTask({
      maxIterations: 100,
      defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: [0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100] });
  });

  test("in task graph mode", async () => {
    const graph = new TaskGraph();
    graph.addTask(
      new MultiplyRunTask({
        maxIterations: 100,
        defaults: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], b: 11 },
      })
    );
    const results = await graph.run<MultiplyOutput>();
    const cleanResults = graph.mergeExecuteOutputsToRunOutput<
      MultiplyOutput,
      typeof PROPERTY_ARRAY
    >(results, PROPERTY_ARRAY);
    expect(cleanResults.result).toEqual([0, 11, 22, 33, 44, 55, 66, 77, 88, 99, 110]);
  });

  test("emits events correctly", async () => {
    // Create a task with a smaller array for testing events
    const task = new SquareRunTask({
      maxIterations: 100,
      defaults: { a: [1, 2, 3] },
    });

    // Create event tracking variables
    const events: Record<string, number> = {
      start: 0,
      progress: 0,
      complete: 0,
    };

    // Set up event listeners
    task.on("start", () => {
      events.start++;
      expect(task.status).toBe(TaskStatus.PROCESSING);
    });

    task.on("progress", (progress: number | undefined) => {
      events.progress++;
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(100);
    });

    task.on("complete", () => {
      events.complete++;
      expect(task.status).toBe(TaskStatus.COMPLETED);
      expect(task.completedAt).toBeDefined();
    });

    // Run the task — it emits start/progress/complete on its own.
    const results = await task.run();

    // Verify events were emitted
    expect(events.start).toBeGreaterThanOrEqual(1);
    expect(events.progress).toBeGreaterThanOrEqual(1);
    expect(events.complete).toBe(1);

    // Verify the task completed successfully
    expect(results).toEqual({ result: [1, 4, 9] });
    expect(task.runOutputData).toEqual({ result: [1, 4, 9] });
  });

  test("child tasks emit events that bubble up to parent", async () => {
    // Create a task with a smaller array for testing events
    const task = new SquareRunTask({
      maxIterations: 100,
      defaults: { a: [1, 2] },
    });

    // Create event tracking variables for parent and children
    const parentEvents: Record<string, number> = {
      start: 0,
      progress: 0,
      complete: 0,
    };

    const childEvents: Record<string, number> = {
      start: 0,
      progress: 0,
      complete: 0,
    };

    // Set up event listeners on parent task
    task.on("start", () => {
      parentEvents.start++;
    });

    task.on("progress", () => {
      parentEvents.progress++;
    });

    task.on("complete", () => {
      parentEvents.complete++;
    });

    // After task is created, we can access its subGraph and child tasks
    task.regenerateGraph();

    // Set up event listeners on child tasks
    task.subGraph!.getTasks().forEach((childTask: ITask) => {
      childTask.on("start", () => {
        childEvents.start++;
      });

      childTask.on("progress", () => {
        childEvents.progress++;
      });

      childTask.on("complete", () => {
        childEvents.complete++;
      });
    });

    // Run the task — start/progress/complete events fire on parent and children
    // through the normal run path.
    await task.run();

    // Verify parent events were emitted
    expect(parentEvents.start).toBeGreaterThanOrEqual(1);
    expect(parentEvents.progress).toBeGreaterThanOrEqual(1);
    expect(parentEvents.complete).toBe(1);

    // Verify child events were emitted
    expect(childEvents.start).toBeGreaterThanOrEqual(2); // At least one for each child task
    expect(childEvents.progress).toBeGreaterThanOrEqual(2); // At least one for each child task
    expect(childEvents.complete).toBe(2); // One for each child task
  });

  test("Task runPreview calls executePreview in single task mode (no children)", async () => {
    // Create a Task with non-array input - this puts it in single task mode (no subtasks)
    const task = new JobQueuePreviewTask({ defaults: { value: 5 } });

    // Verify it has no children (single task mode)
    expect(task.hasChildren()).toBe(false);

    // Spy on executePreview to verify it's called
    const executePreviewSpy = spyOn(task, "executePreview");

    // Call runPreview without calling run() first
    const results = await task.runPreview();

    // Verify executePreview was actually called
    expect(executePreviewSpy).toHaveBeenCalledTimes(1);
    expect(executePreviewSpy).toHaveBeenCalledWith(
      { value: 5 },
      expect.objectContaining({ own: expect.any(Function) })
    );

    // Verify the result is correct (executePreview should have computed it)
    expect(results).toEqual({ result: 10 }); // 5 * 2 = 10
  });

  test("Task runPreview works in single task mode without prior run() call", async () => {
    // This test ensures runPreview works even when run() hasn't been called first
    const task = new JobQueuePreviewTask({ defaults: { value: 7 } });

    // Verify single task mode
    expect(task.hasChildren()).toBe(false);

    // Call runPreview without calling run() first
    const results = await task.runPreview();

    // Should compute the result using executePreview
    expect(results).toEqual({ result: 14 }); // 7 * 2 = 14
    expect(task.runOutputData).toEqual({ result: 14 });
  });

  test("Task runPreview works task graph mode", async () => {
    const graph = new TaskGraph();
    const task1 = new JobQueuePreviewTask2({ id: "task1", defaults: { value: 7 } });
    const task2 = new JobQueuePreviewTask2({ id: "task2", defaults: { value: 8 } });
    graph.addTask(task1);
    graph.addTask(task2);
    graph.addDataflow(new Dataflow("task1", "result", "task2", "value"));
    const results = await graph.runPreview<JobQueueTestOutput>();
    expect(task1.runOutputData).toEqual({ result: 14 });
    expect(task2.runOutputData).toEqual({ result: 28 });
    expect(results[0].data).toEqual({ result: 28 });
  });

  test("QueryAppendTask with single string input run preview", async () => {
    const task = new QueryAppendTask({
      maxIterations: 100,
      defaults: { query: "test", val: 1 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: "test-preview", val: 1 });
  });

  test("QueryAppendTask with array string input run preview", async () => {
    const task = new QueryAppendTask({
      maxIterations: 100,
      defaults: { query: ["test1", "test2"], val: 2 },
    });
    const results = await task.runPreview();
    expect(results).toEqual({ result: ["test1-preview", "test2-preview"], val: 2 });
  });

  test("QueryAppendTask with single string input", async () => {
    // After the run/runPreview split, run() returns execute() output verbatim
    // (no longer overlays executePreview on top).
    const task = new QueryAppendTask({
      maxIterations: 100,
      defaults: { query: "test", val: 1 },
    });
    const results = await task.run();
    expect(results).toEqual({ result: "test-output", val: 1 });
  });

  test("QueryAppendTask with array string input", async () => {
    const task = new QueryAppendTask({
      maxIterations: 100,
      defaults: { query: ["test1", "test2"], val: 2 },
    });
    const results = await task.run();
    expect(results).toEqual({ result: ["test1-output", "test2-output"], val: 2 });
  });

  // Every combination of every replicated input becomes a task, built up front; a
  // fan-out states its bound, as the iterator family's does.
  test("maxIterations is required", () => {
    expect(() => new MultiplyRunTask({ defaults: { a: 1, b: 2 } } as never)).toThrow(
      TaskConfigurationError
    );
    expect(MultiplyRunTask.configSchema()).toMatchObject({ required: ["maxIterations"] });
  });

  test("refuses a product over the bound before building any task", async () => {
    // Literal defaults build the graph in the constructor, so it refuses there.
    expect(
      () =>
        new MultiplyRunTask({
          maxIterations: 5,
          defaults: { a: [1, 2, 3], b: [4, 5] },
        } as never)
    ).toThrow(/6 combinations.*maxIterations 5/);

    // Values arriving through a graph are refused when the run builds the subgraph.
    class EmitArraysTask extends Task<Record<string, never>, { a: number[]; b: number[] }> {
      public static override type = "ArrayTaskTest_EmitArrays";
      public static override outputSchema(): DataPortSchema {
        return {
          type: "object",
          properties: {
            a: { type: "array", items: { type: "number" } },
            b: { type: "array", items: { type: "number" } },
          },
        } as const;
      }
      public override async execute() {
        return { a: [1, 2, 3], b: [4, 5] };
      }
    }
    const graph = new TaskGraph();
    const task = new MultiplyRunTask({ id: "m", maxIterations: 5 } as never);
    graph.addTasks([new EmitArraysTask({ id: "src" }), task]);
    graph.addDataflow(new Dataflow("src", "a", "m", "a"));
    graph.addDataflow(new Dataflow("src", "b", "m", "b"));
    const err = await graph.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskInvalidInputError);
    expect(task.subGraph?.getTasks().length ?? 0).toBe(0);
  });

  test('runs a product within the bound, and "unbounded" opts out', async () => {
    for (const maxIterations of [6, "unbounded"] as const) {
      const task = new MultiplyRunTask({
        maxIterations,
        defaults: { a: [1, 2, 3], b: [4, 5] },
      } as never);
      expect(((await task.run()) as { result: number[] }).result).toHaveLength(6);
    }
  });
});
