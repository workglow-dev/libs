/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskConfigurationError, Workflow } from "@workglow/task-graph";
import { RefineTask } from "@workglow/task-graph/test";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

// ============================================================================
// WhileTask with serialized whileConfig (conditionField/operator/value)
// ============================================================================

describe("WhileTask with serialized whileConfig", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  describe("condition auto-building from extras", () => {
    it("should loop while conditionField less_than conditionValue", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 20,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "less_than",
          conditionValue: "0.9",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      // RefineTask increments quality by 0.2 each iteration starting from 0
      // Iterations: 0->0.2, 0.2->0.4, 0.4->0.6, 0.6->0.8, 0.8->1.0
      // After 5th iteration quality=1.0, condition "quality < 0.9" is false, loop stops
      expect(result.quality).toBeGreaterThanOrEqual(0.9);
      expect(result.value).toBeGreaterThan(0);
    });

    it("should loop while conditionField not_equals conditionValue", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 20,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "not_equals",
          conditionValue: "1",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      expect(result.quality).toBe(1);
    });

    it("should loop while conditionField equals conditionValue (stays in loop while equal)", async () => {
      const workflow = new Workflow();
      // quality starts at 0.2, so "equals 0.2" is true for first iteration only
      // After second iteration quality=0.4, "equals 0.2" is false -> stop
      workflow
        .while({
          maxIterations: 20,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "equals",
          conditionValue: "0.2",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      // First iteration: quality=0.2, condition "quality equals 0.2" => true, continue
      // Second iteration: quality=0.4, condition "quality equals 0.2" => false, stop
      expect(result.quality).toBe(0.4);
    });
  });

  describe("maxIterations safety limit", () => {
    it("should stop at maxIterations when condition never becomes false", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 3,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "less_than",
          conditionValue: "999",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      // RefineTask increments quality by 0.2 each iteration
      // 3 iterations: quality = 0.6
      expect(result.quality).toBeCloseTo(0.6, 10);
    });
  });

  describe("chainIterations behavior", () => {
    it("should pass output as next input when chainIterations is true", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 3,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "less_than",
          conditionValue: "999",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      // With chaining, each iteration builds on previous output
      // Iteration 1: value=0 -> quality=0.2, value=1
      // Iteration 2: quality=0.2 -> quality=0.4, value=2
      // Iteration 3: quality=0.4 -> quality=0.6, value=3
      expect(result.value).toBe(3);
      expect(result.quality).toBeCloseTo(0.6, 10);
    });

    it("should use original input for each iteration when chainIterations is false", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 3,
          chainIterations: false,
          conditionField: "quality",
          conditionOperator: "less_than",
          conditionValue: "999",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      // Without chaining, each iteration gets the original input
      // Every iteration: value=0 -> quality=0.2, value=1
      // Final output is always the same since input doesn't change
      expect(result.value).toBe(1);
      expect(result.quality).toBe(0.2);
    });
  });

  describe("empty conditionField", () => {
    it("should use the raw output when conditionField is empty", async () => {
      const workflow = new Workflow();
      // When conditionField is "", the raw output object is passed to evaluateCondition
      // String(output) will be "[object Object]", so "is_not_empty" should be true
      workflow
        .while({
          maxIterations: 3,
          chainIterations: true,
          conditionField: "",
          conditionOperator: "is_not_empty",
          conditionValue: "",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      // Should loop all 3 iterations since output is always non-empty
      expect(result.quality).toBeCloseTo(0.6, 10);
    });
  });

  describe("still works with function condition", () => {
    it("should prefer config.condition over extras.whileConfig", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          condition: (output: { quality: number }, iteration: number) =>
            output.quality < 0.5 && iteration < 10,
          maxIterations: 20,
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result).toBeDefined();
      // condition function should win: stops when quality >= 0.5
      // Iterations: 0.2, 0.4, 0.6 (stops after 3rd since 0.6 >= 0.5)
      expect(result.quality).toBeGreaterThanOrEqual(0.5);
      expect(result.quality).toBeLessThanOrEqual(0.8);
    });
  });
  // An ordering comparison against a value that is not a number can never be true, and
  // false ends the loop: it ran one pass and the run succeeded with that pass's output,
  // marked only by a warning. Known from the config alone, so refused before any pass.
  describe("an ordering comparison against a non-numeric value", () => {
    it.each(["greater_than", "greater_or_equal", "less_than", "less_or_equal"] as const)(
      "%s refuses the loop before running it",
      async (conditionOperator) => {
        const workflow = new Workflow();
        workflow
          .while({
            maxIterations: 20,
            chainIterations: true,
            conditionField: "quality",
            conditionOperator,
            conditionValue: "ninety",
          })
          .addTask(RefineTask)
          .endWhile();

        const run = workflow.run({ value: 0 });
        await expect(run).rejects.toThrow(TaskConfigurationError);
        await expect(run).rejects.toThrow(/"ninety"/);
      }
    );

    it("still compares strings with equals", async () => {
      const workflow = new Workflow();
      workflow
        .while({
          maxIterations: 3,
          chainIterations: true,
          conditionField: "quality",
          conditionOperator: "not_equals",
          conditionValue: "done",
        })
        .addTask(RefineTask)
        .endWhile();

      const result = await workflow.run({ value: 0 });
      expect(result.value).toBe(3);
    });
  });
});
