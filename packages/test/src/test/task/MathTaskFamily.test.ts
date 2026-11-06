/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Task } from "@workglow/task-graph";
import { TaskInvalidInputError } from "@workglow/task-graph";
import {
  ScalarAbsTask,
  ScalarAddTask,
  ScalarCeilTask,
  ScalarDivideTask,
  ScalarFloorTask,
  ScalarMaxTask,
  ScalarMinTask,
  ScalarMultiplyTask,
  ScalarRoundTask,
  ScalarSubtractTask,
  ScalarSumTask,
  ScalarTruncTask,
  VectorDistanceTask,
  VectorDivideTask,
  VectorDotProductTask,
  VectorMultiplyTask,
  VectorNormalizeTask,
  VectorScaleTask,
  VectorSubtractTask,
  VectorSumTask,
} from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

setLogger(getTestingLogger());

type AnyTaskClass = new () => Task<any, any>;
const f32 = (...values: number[]): Float32Array => new Float32Array(values);

// Every math task with one ordinary input. Pure, instant functions: a builder should be able
// to show their value live, the way it does for the string tasks.
const CASES: ReadonlyArray<readonly [string, AnyTaskClass, Record<string, unknown>]> = [
  ["ScalarAbsTask", ScalarAbsTask, { value: -3 }],
  ["ScalarAddTask", ScalarAddTask, { a: 2, b: 3 }],
  ["ScalarCeilTask", ScalarCeilTask, { value: 1.2 }],
  ["ScalarDivideTask", ScalarDivideTask, { a: 6, b: 3 }],
  ["ScalarFloorTask", ScalarFloorTask, { value: 1.8 }],
  ["ScalarMaxTask", ScalarMaxTask, { values: [1, 5, 3] }],
  ["ScalarMinTask", ScalarMinTask, { values: [4, 2, 9] }],
  ["ScalarMultiplyTask", ScalarMultiplyTask, { a: 2, b: 4 }],
  ["ScalarRoundTask", ScalarRoundTask, { value: 2.5 }],
  ["ScalarSubtractTask", ScalarSubtractTask, { a: 5, b: 3 }],
  ["ScalarSumTask", ScalarSumTask, { values: [1, 2, 3] }],
  ["ScalarTruncTask", ScalarTruncTask, { value: -1.7 }],
  ["VectorDistanceTask", VectorDistanceTask, { vectors: [f32(0, 0), f32(3, 4)] }],
  ["VectorDivideTask", VectorDivideTask, { vectors: [f32(6, 8), f32(2, 4)] }],
  ["VectorDotProductTask", VectorDotProductTask, { vectors: [f32(1, 2), f32(3, 4)] }],
  ["VectorMultiplyTask", VectorMultiplyTask, { vectors: [f32(1, 2), f32(3, 4)] }],
  ["VectorNormalizeTask", VectorNormalizeTask, { vector: f32(3, 4) }],
  ["VectorScaleTask", VectorScaleTask, { vector: f32(1, 2), scalar: 3 }],
  ["VectorSubtractTask", VectorSubtractTask, { vectors: [f32(5, 5), f32(1, 2)] }],
  ["VectorSumTask", VectorSumTask, { vectors: [f32(1, 2), f32(3, 4)] }],
];

describe("math tasks", () => {
  test.each(CASES)("%s previews the value it runs to", async (_name, TaskClass, input) => {
    const ran = await new TaskClass().run(input);
    const previewed = await new TaskClass().runPreview(input);
    expect(previewed).toEqual(ran);
  });

  test.each([
    ["ScalarMaxTask", ScalarMaxTask, 999_999],
    ["ScalarMinTask", ScalarMinTask, 0],
  ] as const)("%s handles an array too large to spread into arguments", async (_n, T, want) => {
    // `Math.max(...values)` passes every element as an argument; engines cap argument
    // counts, and a million elements threw a RangeError instead of returning.
    const values = Array.from({ length: 1_000_000 }, (_, i) => i);
    const result = await new T().run({ values });
    expect(result.result).toBe(want);
  });

  test("max and min keep Math.max/Math.min semantics for NaN and signed zero", async () => {
    expect((await new ScalarMaxTask().run({ values: [1, Number.NaN, 3] })).result).toBeNaN();
    expect((await new ScalarMinTask().run({ values: [1, Number.NaN, 3] })).result).toBeNaN();
    expect(Object.is((await new ScalarMaxTask().run({ values: [-0, 0] })).result, 0)).toBe(true);
    expect(Object.is((await new ScalarMinTask().run({ values: [0, -0] })).result, -0)).toBe(true);
  });

  // An impossible input is refused rather than answered with a value the port cannot
  // carry (±Infinity travels as null) or an answer to a different question.
  test.each([
    ["ScalarMaxTask", ScalarMaxTask],
    ["ScalarMinTask", ScalarMinTask],
  ] as const)("%s declares and refuses an empty list", async (_n, T) => {
    const values = (T.inputSchema() as { properties: { values: { minItems?: number } } }).properties
      .values;
    expect(values.minItems).toBe(1);
    await expect(new T().run({ values: [] })).rejects.toThrow();
    await expect(new T().execute({ values: [] }, {} as never)).rejects.toBeInstanceOf(
      TaskInvalidInputError
    );
  });

  test("VectorDistanceTask takes exactly two vectors", async () => {
    const vectors = (
      VectorDistanceTask.inputSchema() as {
        properties: { vectors: { minItems?: number; maxItems?: number } };
      }
    ).properties.vectors;
    expect([vectors.minItems, vectors.maxItems]).toEqual([2, 2]);
    const three = { vectors: [f32(0, 0), f32(3, 4), f32(100, 100)] };
    await expect(new VectorDistanceTask().run(three)).rejects.toThrow();
    await expect(new VectorDistanceTask().execute(three, {} as never)).rejects.toBeInstanceOf(
      TaskInvalidInputError
    );
  });

  test("VectorDivideTask refuses a zero divisor element, naming where it is", async () => {
    await expect(new VectorDivideTask().run({ vectors: [f32(6, 8), f32(2, 0)] })).rejects.toThrow(
      /vectors\[1\]\[1\]/
    );
    await expect(
      new VectorDivideTask().execute({ vectors: [f32(6, 8), f32(2, 0)] }, {} as never)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    // A zero dividend is fine.
    expect(
      Array.from((await new VectorDivideTask().run({ vectors: [f32(0, 8), f32(2, 4)] })).result)
    ).toEqual([0, 2]);
  });
});
