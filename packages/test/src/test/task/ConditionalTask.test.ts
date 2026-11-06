/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConditionalTask,
  Dataflow,
  Task,
  TaskGraph,
  TaskGraphRunner,
  TaskStatus,
} from "@workglow/task-graph";
import { InMemoryTaskOutputRepository } from "@workglow/task-graph/test";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

import {
  DoubleToDoubledTask as DoubleTask,
  HalveTask,
  ProcessValueTask,
  TrackingTask,
} from "@workglow/task-graph/test";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";

/** Emits the two ports a serialized `conditionConfig` gate routes on. */
class GateSourceTask extends Task<
  { score: number; value: string },
  { score: number; value: string }
> {
  static override type = "GateSourceTask";
  static override category = "Test";
  static override title = "Gate Source";

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { score: { type: "number" }, value: { type: "string" } },
    } as const satisfies DataPortSchema;
  }

  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { score: { type: "number" }, value: { type: "string" } },
    } as const satisfies DataPortSchema;
  }

  override async execute(input: {
    score: number;
    value: string;
  }): Promise<{ score: number; value: string }> {
    return { score: input.score, value: input.value };
  }
}

/** Records whether it ran and what it received, so a disabled branch is observable. */
class GateSinkTask extends Task<{ received: string }, { seen: string }> {
  static override type = "GateSinkTask";
  static override category = "Test";
  static override title = "Gate Sink";

  public calls = 0;

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { received: { type: "string" } },
    } as const satisfies DataPortSchema;
  }

  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { seen: { type: "string" } },
    } as const satisfies DataPortSchema;
  }

  override async execute(input: { received: string }): Promise<{ seen: string }> {
    this.calls++;
    return { seen: input.received };
  }
}

// ============================================================================
// Basic Tests
// ============================================================================

describe("ConditionalTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  describe("ConditionalTask", () => {
    describe("Basic Functionality", () => {
      it("should create a ConditionalTask with branches", () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: (i: any) => i.value <= 5, outputPort: "low" },
          ],
          defaults: { value: 10 },
        });

        expect(task).toBeDefined();
        expect(task.config.branches).toHaveLength(2);
      });

      it("should evaluate conditions and activate correct branch", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: (i: any) => i.value <= 5, outputPort: "low" },
          ],
          defaults: { value: 5 },
        });

        await task.run({ value: 10 });

        expect(task.isBranchActive("high")).toBe(true);
        expect(task.isBranchActive("low")).toBe(false);
      });

      it("should pass input through to active branch output port", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: (i: any) => i.value <= 5, outputPort: "low" },
          ],
        });

        await task.run({ value: 10 });

        expect(task.runOutputData.high).toEqual({ value: 10 });
      });

      it("should handle low value activating low branch", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: (i: any) => i.value <= 5, outputPort: "low" },
          ],
        });

        await task.run({ value: 3 });

        expect(task.isBranchActive("high")).toBe(false);
        expect(task.isBranchActive("low")).toBe(true);
      });
    });

    describe("Exclusive Mode (Default)", () => {
      it("should only activate first matching branch in exclusive mode", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "first", condition: (i: any) => i.value > 10, outputPort: "first" },
            { id: "second", condition: (i: any) => i.value > 5, outputPort: "second" },
            { id: "third", condition: (i: any) => i.value > 0, outputPort: "third" },
          ],
        });

        await task.run({ value: 15 });

        // Only first matching branch should be active
        expect(task.isBranchActive("first")).toBe(true);
        expect(task.isBranchActive("second")).toBe(false);
        expect(task.isBranchActive("third")).toBe(false);
      });

      it("should activate middle branch when first doesn't match", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "first", condition: (i: any) => i.value > 20, outputPort: "first" },
            { id: "second", condition: (i: any) => i.value > 10, outputPort: "second" },
            { id: "third", condition: (i: any) => i.value > 0, outputPort: "third" },
          ],
        });

        await task.run({ value: 15 });

        expect(task.isBranchActive("first")).toBe(false);
        expect(task.isBranchActive("second")).toBe(true);
        expect(task.isBranchActive("third")).toBe(false);
      });
    });

    describe("Multi-Path Mode", () => {
      it("should activate all matching branches in multi-path mode", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "first", condition: (i: any) => i.value > 10, outputPort: "first" },
            { id: "second", condition: (i: any) => i.value > 5, outputPort: "second" },
            { id: "third", condition: (i: any) => i.value > 0, outputPort: "third" },
          ],
          exclusive: false,
        });

        await task.run({ value: 15 });

        // All matching branches should be active
        expect(task.isBranchActive("first")).toBe(true);
        expect(task.isBranchActive("second")).toBe(true);
        expect(task.isBranchActive("third")).toBe(true);
      });

      it("should only activate branches that match in multi-path mode", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "first", condition: (i: any) => i.value > 20, outputPort: "first" },
            { id: "second", condition: (i: any) => i.value > 10, outputPort: "second" },
            { id: "third", condition: (i: any) => i.value > 0, outputPort: "third" },
          ],
          exclusive: false,
        });

        await task.run({ value: 15 });

        expect(task.isBranchActive("first")).toBe(false);
        expect(task.isBranchActive("second")).toBe(true);
        expect(task.isBranchActive("third")).toBe(true);
      });
    });

    describe("Default Branch", () => {
      it("should use default branch when no conditions match", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 100, outputPort: "high" },
            { id: "medium", condition: (i: any) => i.value > 50, outputPort: "medium" },
            { id: "low", condition: () => false, outputPort: "low" },
          ],
          defaultBranch: "low",
        });

        await task.run({ value: 10 });

        expect(task.isBranchActive("high")).toBe(false);
        expect(task.isBranchActive("medium")).toBe(false);
        expect(task.isBranchActive("low")).toBe(true);
      });

      it("should not use default branch when a condition matches", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: () => false, outputPort: "low" },
          ],
          defaultBranch: "low",
        });

        await task.run({ value: 10 });

        expect(task.isBranchActive("high")).toBe(true);
        expect(task.isBranchActive("low")).toBe(false);
      });

      it("should ignore invalid default branch", async () => {
        const task = new ConditionalTask({
          branches: [{ id: "high", condition: (i: any) => i.value > 100, outputPort: "high" }],
          defaultBranch: "nonexistent",
        });

        await task.run({ value: 10 });

        expect(task.activeBranches.size).toBe(0);
      });
    });

    describe("Edge Cases", () => {
      it("should handle empty branches array", async () => {
        const task = new ConditionalTask({
          branches: [],
        });

        await task.run({ value: 10 });

        expect(task.activeBranches.size).toBe(0);
      });

      it("fails the task when a condition throws, naming the branch, instead of routing on", async () => {
        // Treating a throw as "not taken" sent the data down the next branch (here the
        // fallback) and reported success. WhileTask fails on a throwing condition too.
        const task = new ConditionalTask({
          branches: [
            {
              id: "throws",
              condition: () => {
                throw new Error("condition error");
              },
              outputPort: "throws",
            },
            { id: "fallback", condition: () => true, outputPort: "fallback" },
          ],
        });

        await expect(task.run({ value: 10 })).rejects.toThrow(/branch "throws".*condition error/);
        expect(task.isBranchActive("fallback")).toBe(false);
      });

      it("should handle null/undefined input gracefully", async () => {
        const task = new ConditionalTask({
          branches: [
            {
              id: "hasValue",
              condition: (i: any) => i?.value !== undefined,
              outputPort: "hasValue",
            },
            {
              id: "noValue",
              condition: (i: any) => i?.value === undefined,
              outputPort: "noValue",
            },
          ],
        });

        await task.run({});

        expect(task.isBranchActive("noValue")).toBe(true);
      });

      it("should clear active branches between runs", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: (i: any) => i.value > 5, outputPort: "high" },
            { id: "low", condition: (i: any) => i.value <= 5, outputPort: "low" },
          ],
        });

        // First run
        await task.run({ value: 10 });
        expect(task.isBranchActive("high")).toBe(true);

        // Second run with different value
        await task.run({ value: 3 });
        expect(task.isBranchActive("high")).toBe(false);
        expect(task.isBranchActive("low")).toBe(true);
      });
    });

    describe("Port Status Methods", () => {
      it("should return correct port active status", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "a", condition: (i: any) => i.value === "a", outputPort: "portA" },
            { id: "b", condition: (i: any) => i.value === "b", outputPort: "portB" },
          ],
        });

        await task.run({ value: "a" });

        const portStatus = task.getPortActiveStatus();
        expect(portStatus.get("portA")).toBe(true);
        expect(portStatus.get("portB")).toBe(false);
      });

      it("should check individual port active status", async () => {
        const task = new ConditionalTask({
          branches: [
            { id: "active", condition: () => true, outputPort: "activePort" },
            { id: "inactive", condition: () => false, outputPort: "inactivePort" },
          ],
        });

        await task.run({});

        expect(task.isBranchActive("active")).toBe(true);
        expect(task.isBranchActive("inactive")).toBe(false);
      });
    });

    describe("Dynamic Output Schema", () => {
      it("should generate output schema based on branches", () => {
        const task = new ConditionalTask({
          branches: [
            { id: "high", condition: () => true, outputPort: "highOutput" },
            { id: "low", condition: () => false, outputPort: "lowOutput" },
          ],
        });

        const schema = task.outputSchema();

        // Schema is object type with properties
        expect(typeof schema).toBe("object");
        expect(schema).not.toBe(true);
        expect(schema).not.toBe(false);
        if (typeof schema === "object") {
          expect(schema.properties).toHaveProperty("_activeBranches");
          expect(schema.properties).toHaveProperty("highOutput");
          expect(schema.properties).toHaveProperty("lowOutput");
        }
      });
    });
  });

  // ============================================================================
  // Graph Integration Tests
  // ============================================================================

  describe("ConditionalTask Graph Integration", () => {
    describe("Basic Graph Routing", () => {
      it("should route to correct downstream task in simple if/else", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "double", condition: (i: any) => i.value > 5, outputPort: "forDouble" },
            { id: "halve", condition: (i: any) => i.value <= 5, outputPort: "forHalve" },
          ],
        });

        const doubleTask = new TrackingTask({ id: "double" });
        const halveTask = new TrackingTask({ id: "halve" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, doubleTask, halveTask]);

        graph.addDataflow(new Dataflow(conditional.id, "forDouble", doubleTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "forHalve", halveTask.id, "input"));

        await graph.run({ value: 10 });

        // Double task should have executed, halve task should be disabled
        expect(doubleTask.executed).toBe(true);
        expect(halveTask.status).toBe(TaskStatus.DISABLED);
      });

      it("should disable downstream task when branch not taken", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "taken", condition: () => true, outputPort: "taken" },
            { id: "notTaken", condition: () => false, outputPort: "notTaken" },
          ],
        });

        const takenTask = new TrackingTask({ id: "taken" });
        const notTakenTask = new TrackingTask({ id: "notTaken" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, takenTask, notTakenTask]);

        graph.addDataflow(new Dataflow(conditional.id, "taken", takenTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "notTaken", notTakenTask.id, "input"));

        await graph.run({});

        expect(takenTask.executed).toBe(true);
        expect(takenTask.status).toBe(TaskStatus.COMPLETED);
        expect(notTakenTask.executed).toBe(false);
        expect(notTakenTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Disabled Cascading", () => {
      it("should cascade disabled status through multiple levels", async () => {
        // Graph: Conditional -> Task1 -> Task2 -> Task3
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "active", condition: () => true, outputPort: "active" },
            { id: "inactive", condition: () => false, outputPort: "inactive" },
          ],
        });

        const activeTask1 = new TrackingTask({ id: "activeTask1" });
        const inactiveTask1 = new TrackingTask({ id: "inactiveTask1" });
        const inactiveTask2 = new TrackingTask({ id: "inactiveTask2" });
        const inactiveTask3 = new TrackingTask({ id: "inactiveTask3" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, activeTask1, inactiveTask1, inactiveTask2, inactiveTask3]);

        // Active path
        graph.addDataflow(new Dataflow(conditional.id, "active", activeTask1.id, "input"));

        // Inactive path (cascading)
        graph.addDataflow(new Dataflow(conditional.id, "inactive", inactiveTask1.id, "input"));
        graph.addDataflow(new Dataflow(inactiveTask1.id, "executed", inactiveTask2.id, "input"));
        graph.addDataflow(new Dataflow(inactiveTask2.id, "executed", inactiveTask3.id, "input"));

        await graph.run({});

        // Active path should execute
        expect(activeTask1.status).toBe(TaskStatus.COMPLETED);

        // Entire inactive path should be disabled
        expect(inactiveTask1.status).toBe(TaskStatus.DISABLED);
        expect(inactiveTask2.status).toBe(TaskStatus.DISABLED);
        expect(inactiveTask3.status).toBe(TaskStatus.DISABLED);
      });

      it("should not disable task with mixed inputs (some active, some disabled)", async () => {
        // Graph:
        //   Conditional (active) -----> MergeTask
        //   Conditional (inactive) ---> MergeTask
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "active", condition: () => true, outputPort: "active" },
            { id: "inactive", condition: () => false, outputPort: "inactive" },
          ],
        });

        const mergeTask = new TrackingTask({ id: "merge" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, mergeTask]);

        // Both branches connect to the same task
        graph.addDataflow(new Dataflow(conditional.id, "active", mergeTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "inactive", mergeTask.id, "input"));

        await graph.run({});

        // Merge task should execute because it has at least one active input
        expect(mergeTask.status).toBe(TaskStatus.COMPLETED);
        expect(mergeTask.executed).toBe(true);
      });
    });

    describe("Switch/Case Pattern", () => {
      it("should route based on enum-like value", async () => {
        const switchTask = new ConditionalTask({
          id: "switchTask",
          branches: [
            { id: "caseA", condition: (i: any) => i.type === "A", outputPort: "typeA" },
            { id: "caseB", condition: (i: any) => i.type === "B", outputPort: "typeB" },
            { id: "caseC", condition: (i: any) => i.type === "C", outputPort: "typeC" },
          ],
          exclusive: true,
        });

        const taskA = new TrackingTask({ id: "taskA" });
        const taskB = new TrackingTask({ id: "taskB" });
        const taskC = new TrackingTask({ id: "taskC" });

        const graph = new TaskGraph();
        graph.addTasks([switchTask, taskA, taskB, taskC]);

        graph.addDataflow(new Dataflow(switchTask.id, "typeA", taskA.id, "input"));
        graph.addDataflow(new Dataflow(switchTask.id, "typeB", taskB.id, "input"));
        graph.addDataflow(new Dataflow(switchTask.id, "typeC", taskC.id, "input"));

        await graph.run({ type: "B" });

        expect(taskA.status).toBe(TaskStatus.DISABLED);
        expect(taskB.status).toBe(TaskStatus.COMPLETED);
        expect(taskC.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Multi-Path Execution", () => {
      it("should execute multiple downstream tasks in multi-path mode", async () => {
        const multiPath = new ConditionalTask({
          id: "multiPath",
          branches: [
            { id: "path1", condition: () => true, outputPort: "path1" },
            { id: "path2", condition: () => true, outputPort: "path2" },
            { id: "path3", condition: () => false, outputPort: "path3" },
          ],
          exclusive: false,
        });

        const task1 = new TrackingTask({ id: "task1" });
        const task2 = new TrackingTask({ id: "task2" });
        const task3 = new TrackingTask({ id: "task3" });

        const graph = new TaskGraph();
        graph.addTasks([multiPath, task1, task2, task3]);

        graph.addDataflow(new Dataflow(multiPath.id, "path1", task1.id, "input"));
        graph.addDataflow(new Dataflow(multiPath.id, "path2", task2.id, "input"));
        graph.addDataflow(new Dataflow(multiPath.id, "path3", task3.id, "input"));

        await graph.run({});

        expect(task1.status).toBe(TaskStatus.COMPLETED);
        expect(task2.status).toBe(TaskStatus.COMPLETED);
        expect(task3.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Chained Conditionals", () => {
      it("should handle chained conditional tasks", async () => {
        // First conditional routes by type
        const typeConditional = new ConditionalTask({
          id: "typeConditional",
          branches: [
            {
              id: "premium",
              condition: (i: any) => i.userType === "premium",
              outputPort: "premium",
            },
            {
              id: "standard",
              condition: (i: any) => i.userType === "standard",
              outputPort: "standard",
            },
          ],
        });

        // Second conditional routes premium users by tier
        const tierConditional = new ConditionalTask({
          id: "tierConditional",
          branches: [
            { id: "gold", condition: (i: any) => i.premium?.tier === "gold", outputPort: "gold" },
            {
              id: "silver",
              condition: (i: any) => i.premium?.tier === "silver",
              outputPort: "silver",
            },
          ],
        });

        const goldTask = new TrackingTask({ id: "goldTask" });
        const silverTask = new TrackingTask({ id: "silverTask" });
        const standardTask = new TrackingTask({ id: "standardTask" });

        const graph = new TaskGraph();
        graph.addTasks([typeConditional, tierConditional, goldTask, silverTask, standardTask]);

        // Type conditional outputs
        graph.addDataflow(
          new Dataflow(typeConditional.id, "premium", tierConditional.id, "premium")
        );
        graph.addDataflow(new Dataflow(typeConditional.id, "standard", standardTask.id, "input"));

        // Tier conditional outputs
        graph.addDataflow(new Dataflow(tierConditional.id, "gold", goldTask.id, "input"));
        graph.addDataflow(new Dataflow(tierConditional.id, "silver", silverTask.id, "input"));

        await graph.run({ userType: "premium", tier: "gold" });

        expect(standardTask.status).toBe(TaskStatus.DISABLED);
        expect(goldTask.status).toBe(TaskStatus.COMPLETED);
        expect(silverTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Dataflow Status", () => {
      it("should set correct status on dataflows", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "active", condition: () => true, outputPort: "active" },
            { id: "inactive", condition: () => false, outputPort: "inactive" },
          ],
        });

        const activeTask = new TrackingTask({ id: "active" });
        const inactiveTask = new TrackingTask({ id: "inactive" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, activeTask, inactiveTask]);

        const activeDataflow = new Dataflow(conditional.id, "active", activeTask.id, "input");
        const inactiveDataflow = new Dataflow(conditional.id, "inactive", inactiveTask.id, "input");

        graph.addDataflow(activeDataflow);
        graph.addDataflow(inactiveDataflow);

        await graph.run({});

        expect(activeDataflow.status).toBe(TaskStatus.COMPLETED);
        expect(inactiveDataflow.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Serialized conditionConfig Gates", () => {
      const gateInputSchema = {
        type: "object",
        properties: {
          score: { type: "number" },
          value: { type: "string" },
        },
        additionalProperties: true,
      } as const satisfies DataPortSchema;

      it("delivers data through the suffixed ports of a conditionConfig gate", async () => {
        const source = new GateSourceTask({ id: "source" });
        const gate = new ConditionalTask({
          id: "gate",
          inputSchema: gateInputSchema,
          conditionConfig: {
            branches: [
              { id: "confident", field: "score", operator: "greater_or_equal", value: "0.8" },
            ],
            exclusive: true,
          },
        });
        const sink = new GateSinkTask({ id: "sink" });

        const graph = new TaskGraph();
        graph.addTasks([source, gate, sink]);
        graph.addDataflow(new Dataflow(source.id, "score", gate.id, "score"));
        graph.addDataflow(new Dataflow(source.id, "value", gate.id, "value"));
        graph.addDataflow(new Dataflow(gate.id, "value_1", sink.id, "received"));

        await graph.run({ score: 0.9, value: "payload" });

        expect(sink.calls).toBe(1);
        expect(sink.status).toBe(TaskStatus.COMPLETED);
        expect(sink.runOutputData.seen).toBe("payload");
      });

      it("disables the branch edge and cascades when a conditionConfig gate falls to else", async () => {
        const source = new GateSourceTask({ id: "source" });
        const gate = new ConditionalTask({
          id: "gate",
          inputSchema: gateInputSchema,
          conditionConfig: {
            branches: [
              { id: "confident", field: "score", operator: "greater_or_equal", value: "0.8" },
            ],
            exclusive: true,
          },
        });
        const sink = new GateSinkTask({ id: "sink" });

        const graph = new TaskGraph();
        graph.addTasks([source, gate, sink]);
        graph.addDataflow(new Dataflow(source.id, "score", gate.id, "score"));
        graph.addDataflow(new Dataflow(source.id, "value", gate.id, "value"));
        const branchDataflow = new Dataflow(gate.id, "value_1", sink.id, "received");
        graph.addDataflow(branchDataflow);

        await graph.run({ score: 0.2, value: "payload" });

        expect(branchDataflow.status).toBe(TaskStatus.DISABLED);
        expect(sink.status).toBe(TaskStatus.DISABLED);
        expect(sink.calls).toBe(0);
      });

      it("activates matching ports independently in non-exclusive mode", async () => {
        const source = new GateSourceTask({ id: "source" });
        const gate = new ConditionalTask({
          id: "gate",
          inputSchema: gateInputSchema,
          conditionConfig: {
            branches: [
              { id: "one", field: "score", operator: "greater_than", value: "0.1" },
              { id: "two", field: "score", operator: "greater_than", value: "0.2" },
              { id: "three", field: "score", operator: "greater_than", value: "0.9" },
            ],
            exclusive: false,
          },
        });
        const sinkOne = new GateSinkTask({ id: "sinkOne" });
        const sinkTwo = new GateSinkTask({ id: "sinkTwo" });
        const sinkThree = new GateSinkTask({ id: "sinkThree" });

        const graph = new TaskGraph();
        graph.addTasks([source, gate, sinkOne, sinkTwo, sinkThree]);
        graph.addDataflow(new Dataflow(source.id, "score", gate.id, "score"));
        graph.addDataflow(new Dataflow(source.id, "value", gate.id, "value"));
        graph.addDataflow(new Dataflow(gate.id, "value_1", sinkOne.id, "received"));
        graph.addDataflow(new Dataflow(gate.id, "value_2", sinkTwo.id, "received"));
        graph.addDataflow(new Dataflow(gate.id, "value_3", sinkThree.id, "received"));

        await graph.run({ score: 0.5, value: "payload" });

        expect(sinkOne.status).toBe(TaskStatus.COMPLETED);
        expect(sinkOne.runOutputData.seen).toBe("payload");
        expect(sinkTwo.status).toBe(TaskStatus.COMPLETED);
        expect(sinkTwo.runOutputData.seen).toBe("payload");
        expect(sinkThree.status).toBe(TaskStatus.DISABLED);
        expect(sinkThree.calls).toBe(0);
      });

      it("routes the same way on a second run sharing an output cache", async () => {
        // A cache hit returns the output without entering `execute`, so the
        // gate's in-memory routing state is never populated. Fresh task
        // instances (a reloaded graph) are what expose it: the gate must still
        // disable the untaken branch rather than serve a cached completion.
        const repo = new InMemoryTaskOutputRepository();

        const build = () => {
          const source = new GateSourceTask({ id: "source" });
          const gate = new ConditionalTask({
            id: "gate",
            inputSchema: gateInputSchema,
            conditionConfig: {
              branches: [
                { id: "confident", field: "score", operator: "greater_or_equal", value: "0.8" },
              ],
              exclusive: true,
            },
          });
          const sink = new GateSinkTask({ id: "sink" });
          const graph = new TaskGraph();
          graph.addTasks([source, gate, sink]);
          graph.addDataflow(new Dataflow(source.id, "score", gate.id, "score"));
          graph.addDataflow(new Dataflow(source.id, "value", gate.id, "value"));
          const branch = new Dataflow(gate.id, "value_1", sink.id, "received");
          graph.addDataflow(branch);
          return { graph, sink, branch };
        };

        const first = build();
        await new TaskGraphRunner(first.graph).runGraph(
          { score: 0.2, value: "payload" },
          { outputCache: repo }
        );
        expect(first.branch.status).toBe(TaskStatus.DISABLED);
        expect(first.sink.calls).toBe(0);

        const second = build();
        await new TaskGraphRunner(second.graph).runGraph(
          { score: 0.2, value: "payload" },
          { outputCache: repo }
        );
        expect(second.branch.status).toBe(TaskStatus.DISABLED);
        expect(second.sink.status).toBe(TaskStatus.DISABLED);
        expect(second.sink.calls).toBe(0);
      });
    });
  });

  // ============================================================================
  // Complex Scenario Tests
  // ============================================================================

  describe("ConditionalTask Complex Scenarios", () => {
    describe("Diamond Pattern with Conditional", () => {
      it("should handle diamond pattern where paths reconverge", async () => {
        // Graph:
        //        Conditional
        //       /          \
        //    TaskA       TaskB (disabled)
        //       \          /
        //        MergeTask
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "pathA", condition: () => true, outputPort: "pathA" },
            { id: "pathB", condition: () => false, outputPort: "pathB" },
          ],
        });

        const taskA = new DoubleTask({ id: "taskA" });
        const taskB = new HalveTask({ id: "taskB" });
        const mergeTask = new TrackingTask({ id: "merge" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, taskA, taskB, mergeTask]);

        graph.addDataflow(new Dataflow(conditional.id, "pathA", taskA.id, "value"));
        graph.addDataflow(new Dataflow(conditional.id, "pathB", taskB.id, "value"));
        graph.addDataflow(new Dataflow(taskA.id, "doubled", mergeTask.id, "input"));
        graph.addDataflow(new Dataflow(taskB.id, "halved", mergeTask.id, "input"));

        await graph.run({ value: 10 });

        expect(taskA.status).toBe(TaskStatus.COMPLETED);
        expect(taskB.status).toBe(TaskStatus.DISABLED);
        // Merge task should execute because it has at least one active input
        expect(mergeTask.status).toBe(TaskStatus.COMPLETED);
      });
    });

    describe("No Matching Branches", () => {
      it("should disable all downstream tasks when no branch matches and no default", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "high", condition: (i: any) => i.value > 100, outputPort: "high" },
            { id: "medium", condition: (i: any) => i.value > 50, outputPort: "medium" },
            // No default branch
          ],
        });

        const highTask = new TrackingTask({ id: "high" });
        const mediumTask = new TrackingTask({ id: "medium" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, highTask, mediumTask]);

        graph.addDataflow(new Dataflow(conditional.id, "high", highTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "medium", mediumTask.id, "input"));

        await graph.run({ value: 10 }); // No branch matches

        expect(highTask.status).toBe(TaskStatus.DISABLED);
        expect(mediumTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Mixed Task Types", () => {
      it("should work with ConditionalTask mixed with regular tasks", async () => {
        // Graph: InputTask -> ConditionalTask -> OutputTask1/OutputTask2
        const inputTask = new DoubleTask({ id: "input" });

        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "large", condition: (i: any) => i.doubled > 10, outputPort: "large" },
            { id: "small", condition: (i: any) => i.doubled <= 10, outputPort: "small" },
          ],
        });

        const largeTask = new TrackingTask({ id: "large" });
        const smallTask = new TrackingTask({ id: "small" });

        const graph = new TaskGraph();
        graph.addTasks([inputTask, conditional, largeTask, smallTask]);

        graph.addDataflow(new Dataflow(inputTask.id, "doubled", conditional.id, "doubled"));
        graph.addDataflow(new Dataflow(conditional.id, "large", largeTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "small", smallTask.id, "input"));

        await graph.run({ value: 10 }); // doubled = 20 > 10, so large path

        expect(inputTask.status).toBe(TaskStatus.COMPLETED);
        expect(conditional.status).toBe(TaskStatus.COMPLETED);
        expect(largeTask.status).toBe(TaskStatus.COMPLETED);
        expect(smallTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Multiple Conditionals in Parallel", () => {
      it("should handle multiple independent conditional tasks", async () => {
        const conditional1 = new ConditionalTask({
          id: "cond1",
          branches: [
            { id: "yes1", condition: (i: any) => i.flag1, outputPort: "yes1" },
            { id: "no1", condition: (i: any) => !i.flag1, outputPort: "no1" },
          ],
        });

        const conditional2 = new ConditionalTask({
          id: "cond2",
          branches: [
            { id: "yes2", condition: (i: any) => i.flag2, outputPort: "yes2" },
            { id: "no2", condition: (i: any) => !i.flag2, outputPort: "no2" },
          ],
        });

        const task1Yes = new TrackingTask({ id: "task1Yes" });
        const task1No = new TrackingTask({ id: "task1No" });
        const task2Yes = new TrackingTask({ id: "task2Yes" });
        const task2No = new TrackingTask({ id: "task2No" });

        const graph = new TaskGraph();
        graph.addTasks([conditional1, conditional2, task1Yes, task1No, task2Yes, task2No]);

        graph.addDataflow(new Dataflow(conditional1.id, "yes1", task1Yes.id, "input"));
        graph.addDataflow(new Dataflow(conditional1.id, "no1", task1No.id, "input"));
        graph.addDataflow(new Dataflow(conditional2.id, "yes2", task2Yes.id, "input"));
        graph.addDataflow(new Dataflow(conditional2.id, "no2", task2No.id, "input"));

        await graph.run({ flag1: true, flag2: false });

        // Conditional 1: flag1=true -> yes1 active
        expect(task1Yes.status).toBe(TaskStatus.COMPLETED);
        expect(task1No.status).toBe(TaskStatus.DISABLED);

        // Conditional 2: flag2=false -> no2 active
        expect(task2Yes.status).toBe(TaskStatus.DISABLED);
        expect(task2No.status).toBe(TaskStatus.COMPLETED);
      });
    });

    describe("ProcessValueTask Integration", () => {
      it("should route to ProcessValueTask and get processed result", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "process",
              condition: (i: any) => i.shouldProcess === true,
              outputPort: "toProcess",
            },
            {
              id: "skip",
              condition: (i: any) => i.shouldProcess === false,
              outputPort: "toSkip",
            },
          ],
        });

        const processTask = new ProcessValueTask({ id: "processor" });
        const skipTask = new TrackingTask({ id: "skipper" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, processTask, skipTask]);

        // Use DATAFLOW_ALL_PORTS to pass all data through
        graph.addDataflow(new Dataflow(conditional.id, "toProcess", processTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "toSkip", skipTask.id, "input"));

        await graph.run({ shouldProcess: true, value: 42 });

        expect(processTask.status).toBe(TaskStatus.COMPLETED);
        expect(skipTask.status).toBe(TaskStatus.DISABLED);
        expect(processTask.runOutputData.result).toBe("processed-42");
      });

      it("should skip ProcessValueTask when condition is false", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "process",
              condition: (i: any) => i.shouldProcess === true,
              outputPort: "toProcess",
            },
            {
              id: "skip",
              condition: (i: any) => i.shouldProcess === false,
              outputPort: "toSkip",
            },
          ],
        });

        const processTask = new ProcessValueTask({ id: "processor" });
        const skipTask = new TrackingTask({ id: "skipper" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, processTask, skipTask]);

        graph.addDataflow(new Dataflow(conditional.id, "toProcess", processTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "toSkip", skipTask.id, "input"));

        await graph.run({ shouldProcess: false, value: 42 });

        expect(processTask.status).toBe(TaskStatus.DISABLED);
        expect(skipTask.status).toBe(TaskStatus.COMPLETED);
        expect(skipTask.executed).toBe(true);
      });

      it("should chain ProcessValueTask after conditional with DoubleTask", async () => {
        // Graph: DoubleTask -> ConditionalTask -> ProcessValueTask/HalveTask
        const doubler = new DoubleTask({ id: "doubler" });

        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "big", condition: (i: any) => i.doubled > 50, outputPort: "big" },
            { id: "small", condition: (i: any) => i.doubled <= 50, outputPort: "small" },
          ],
        });

        const processTask = new ProcessValueTask({ id: "processor" });
        const halveTask = new HalveTask({ id: "halver" });

        const graph = new TaskGraph();
        graph.addTasks([doubler, conditional, processTask, halveTask]);

        graph.addDataflow(new Dataflow(doubler.id, "doubled", conditional.id, "doubled"));
        // Use DATAFLOW_ALL_PORTS for ProcessValueTask
        graph.addDataflow(new Dataflow(conditional.id, "big", processTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "small", halveTask.id, "*"));

        // Input 30 -> doubled = 60 -> big branch (60 > 50)
        await graph.run({ value: 30 });

        expect(doubler.status).toBe(TaskStatus.COMPLETED);
        expect(doubler.runOutputData.doubled).toBe(60);
        expect(conditional.status).toBe(TaskStatus.COMPLETED);
        expect(processTask.status).toBe(TaskStatus.COMPLETED);
        expect(halveTask.status).toBe(TaskStatus.DISABLED);
      });

      it("should handle ProcessValueTask on the small branch", async () => {
        const doubler = new DoubleTask({ id: "doubler" });

        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "big", condition: (i: any) => i.doubled > 50, outputPort: "big" },
            { id: "small", condition: (i: any) => i.doubled <= 50, outputPort: "small" },
          ],
        });

        const bigTask = new TrackingTask({ id: "bigTask" });
        const smallTask = new TrackingTask({ id: "smallTask" });

        const graph = new TaskGraph();
        graph.addTasks([doubler, conditional, bigTask, smallTask]);

        graph.addDataflow(new Dataflow(doubler.id, "doubled", conditional.id, "doubled"));
        graph.addDataflow(new Dataflow(conditional.id, "big", bigTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "small", smallTask.id, "input"));

        // Input 10 -> doubled = 20 -> small branch (20 <= 50)
        await graph.run({ value: 10 });

        expect(doubler.runOutputData.doubled).toBe(20);
        expect(bigTask.status).toBe(TaskStatus.DISABLED);
        expect(smallTask.status).toBe(TaskStatus.COMPLETED);
        expect(smallTask.executed).toBe(true);
      });
    });

    describe("Real-World Patterns", () => {
      it("should implement a validation pipeline pattern", async () => {
        const validator = new ConditionalTask({
          id: "validator",
          branches: [
            {
              id: "valid",
              condition: (i: any) => i.value > 0 && i.value < 1000,
              outputPort: "valid",
            },
            {
              id: "invalid",
              condition: (i: any) => i.value <= 0 || i.value >= 1000,
              outputPort: "invalid",
            },
          ],
        });

        const processTask = new ProcessValueTask({ id: "process" });
        const errorHandler = new TrackingTask({ id: "errorHandler" });

        const graph = new TaskGraph();
        graph.addTasks([validator, processTask, errorHandler]);

        graph.addDataflow(new Dataflow(validator.id, "valid", processTask.id, "*"));
        graph.addDataflow(new Dataflow(validator.id, "invalid", errorHandler.id, "input"));

        // Valid input
        await graph.run({ value: 500 });
        expect(processTask.status).toBe(TaskStatus.COMPLETED);
        expect(errorHandler.status).toBe(TaskStatus.DISABLED);

        // Reset and test invalid input
        graph.resetGraph();
        await graph.run({ value: -10 });
        expect(processTask.status).toBe(TaskStatus.DISABLED);
        expect(errorHandler.status).toBe(TaskStatus.COMPLETED);
      });

      it("should implement a tiered processing pattern", async () => {
        const router = new ConditionalTask({
          id: "router",
          branches: [
            {
              id: "critical",
              condition: (i: any) => i.priority === "critical",
              outputPort: "critical",
            },
            { id: "high", condition: (i: any) => i.priority === "high", outputPort: "high" },
            {
              id: "normal",
              condition: (i: any) => i.priority === "normal",
              outputPort: "normal",
            },
            { id: "low", condition: (i: any) => i.priority === "low", outputPort: "low" },
          ],
          defaultBranch: "normal",
          exclusive: true,
        });

        const criticalTask = new ProcessValueTask({ id: "criticalProcessor" });
        const highTask = new ProcessValueTask({ id: "highProcessor" });
        const normalTask = new ProcessValueTask({ id: "normalProcessor" });
        const lowTask = new ProcessValueTask({ id: "lowProcessor" });

        const graph = new TaskGraph();
        graph.addTasks([router, criticalTask, highTask, normalTask, lowTask]);

        graph.addDataflow(new Dataflow(router.id, "critical", criticalTask.id, "*"));
        graph.addDataflow(new Dataflow(router.id, "high", highTask.id, "*"));
        graph.addDataflow(new Dataflow(router.id, "normal", normalTask.id, "*"));
        graph.addDataflow(new Dataflow(router.id, "low", lowTask.id, "*"));

        await graph.run({ priority: "high", value: 100 });

        expect(criticalTask.status).toBe(TaskStatus.DISABLED);
        expect(highTask.status).toBe(TaskStatus.COMPLETED);
        expect(normalTask.status).toBe(TaskStatus.DISABLED);
        expect(lowTask.status).toBe(TaskStatus.DISABLED);
        expect(highTask.runOutputData.result).toBe("processed-100");
      });

      it("should implement a feature flag pattern", async () => {
        const featureGate = new ConditionalTask({
          id: "featureGate",
          branches: [
            { id: "v2", condition: (i: any) => i.features?.v2Enabled === true, outputPort: "v2" },
            { id: "v1", condition: (i: any) => i.features?.v2Enabled !== true, outputPort: "v1" },
          ],
        });

        const v2Processor = new DoubleTask({ id: "v2Processor" });
        const v1Processor = new HalveTask({ id: "v1Processor" });

        const graph = new TaskGraph();
        graph.addTasks([featureGate, v2Processor, v1Processor]);

        graph.addDataflow(new Dataflow(featureGate.id, "v2", v2Processor.id, "*"));
        graph.addDataflow(new Dataflow(featureGate.id, "v1", v1Processor.id, "*"));

        // Test with v2 enabled
        await graph.run({ features: { v2Enabled: true }, value: 100 });
        expect(v2Processor.status).toBe(TaskStatus.COMPLETED);
        expect(v1Processor.status).toBe(TaskStatus.DISABLED);

        // Reset and test with v2 disabled
        graph.resetGraph();
        await graph.run({ features: { v2Enabled: false }, value: 100 });
        expect(v2Processor.status).toBe(TaskStatus.DISABLED);
        expect(v1Processor.status).toBe(TaskStatus.COMPLETED);
      });

      it("should implement a load balancing pattern with multi-path", async () => {
        const fanOut = new ConditionalTask({
          id: "fanOut",
          branches: [
            { id: "processor1", condition: () => true, outputPort: "proc1" },
            { id: "processor2", condition: () => true, outputPort: "proc2" },
            { id: "processor3", condition: () => true, outputPort: "proc3" },
          ],
          exclusive: false,
        });

        const proc1 = new ProcessValueTask({ id: "proc1" });
        const proc2 = new DoubleTask({ id: "proc2" });
        const proc3 = new HalveTask({ id: "proc3" });

        const graph = new TaskGraph();
        graph.addTasks([fanOut, proc1, proc2, proc3]);

        graph.addDataflow(new Dataflow(fanOut.id, "proc1", proc1.id, "*"));
        graph.addDataflow(new Dataflow(fanOut.id, "proc2", proc2.id, "*"));
        graph.addDataflow(new Dataflow(fanOut.id, "proc3", proc3.id, "*"));

        await graph.run({ value: 100 });

        expect(proc1.status).toBe(TaskStatus.COMPLETED);
        expect(proc2.status).toBe(TaskStatus.COMPLETED);
        expect(proc3.status).toBe(TaskStatus.COMPLETED);

        expect(proc1.runOutputData.result).toBe("processed-100");
        expect(proc2.runOutputData.doubled).toBe(200);
        expect(proc3.runOutputData.halved).toBe(50);
      });
    });

    describe("Event Handling", () => {
      it("should emit disabled event for inactive branch tasks", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "active", condition: () => true, outputPort: "active" },
            { id: "inactive", condition: () => false, outputPort: "inactive" },
          ],
        });

        const activeTask = new TrackingTask({ id: "active" });
        const inactiveTask = new TrackingTask({ id: "inactive" });

        let disabledEventFired = false;
        inactiveTask.on("disabled", () => {
          disabledEventFired = true;
        });

        const graph = new TaskGraph();
        graph.addTasks([conditional, activeTask, inactiveTask]);

        graph.addDataflow(new Dataflow(conditional.id, "active", activeTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "inactive", inactiveTask.id, "input"));

        await graph.run({});

        expect(inactiveTask.status).toBe(TaskStatus.DISABLED);
        expect(disabledEventFired).toBe(true);
      });

      it("should emit status event with DISABLED for inactive tasks", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "yes", condition: () => true, outputPort: "yes" },
            { id: "no", condition: () => false, outputPort: "no" },
          ],
        });

        const noTask = new TrackingTask({ id: "noTask" });
        const yesTask = new TrackingTask({ id: "yesTask" });

        const statusEvents: TaskStatus[] = [];
        noTask.on("status", (status) => {
          statusEvents.push(status);
        });

        const graph = new TaskGraph();
        graph.addTasks([conditional, yesTask, noTask]);

        graph.addDataflow(new Dataflow(conditional.id, "yes", yesTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "no", noTask.id, "input"));

        await graph.run({});

        expect(statusEvents).toContain(TaskStatus.DISABLED);
      });
    });

    describe("Boundary Conditions", () => {
      it("should handle very large numbers in conditions", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "huge",
              condition: (i: any) => i.value > Number.MAX_SAFE_INTEGER / 2,
              outputPort: "huge",
            },
            {
              id: "normal",
              condition: (i: any) => i.value <= Number.MAX_SAFE_INTEGER / 2,
              outputPort: "normal",
            },
          ],
        });

        const hugeTask = new ProcessValueTask({ id: "huge" });
        const normalTask = new ProcessValueTask({ id: "normal" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, hugeTask, normalTask]);

        graph.addDataflow(new Dataflow(conditional.id, "huge", hugeTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "normal", normalTask.id, "*"));

        await graph.run({ value: Number.MAX_SAFE_INTEGER });

        expect(hugeTask.status).toBe(TaskStatus.COMPLETED);
        expect(normalTask.status).toBe(TaskStatus.DISABLED);
      });

      it("should handle string comparison conditions", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "admin", condition: (i: any) => i.role === "admin", outputPort: "admin" },
            { id: "user", condition: (i: any) => i.role === "user", outputPort: "user" },
            { id: "guest", condition: (i: any) => i.role === "guest", outputPort: "guest" },
          ],
          defaultBranch: "guest",
        });

        const adminTask = new TrackingTask({ id: "admin" });
        const userTask = new TrackingTask({ id: "user" });
        const guestTask = new TrackingTask({ id: "guest" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, adminTask, userTask, guestTask]);

        graph.addDataflow(new Dataflow(conditional.id, "admin", adminTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "user", userTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "guest", guestTask.id, "input"));

        await graph.run({ role: "user", value: 42 });

        expect(adminTask.status).toBe(TaskStatus.DISABLED);
        expect(userTask.status).toBe(TaskStatus.COMPLETED);
        expect(guestTask.status).toBe(TaskStatus.DISABLED);
      });

      it("should handle array-based conditions", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "hasItems",
              condition: (i: any) => Array.isArray(i.items) && i.items.length > 0,
              outputPort: "hasItems",
            },
            {
              id: "empty",
              condition: (i: any) => !Array.isArray(i.items) || i.items.length === 0,
              outputPort: "empty",
            },
          ],
        });

        const hasItemsTask = new ProcessValueTask({ id: "hasItems" });
        const emptyTask = new TrackingTask({ id: "empty" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, hasItemsTask, emptyTask]);

        graph.addDataflow(new Dataflow(conditional.id, "hasItems", hasItemsTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "empty", emptyTask.id, "input"));

        await graph.run({ items: [1, 2, 3], value: 100 });

        expect(hasItemsTask.status).toBe(TaskStatus.COMPLETED);
        expect(emptyTask.status).toBe(TaskStatus.DISABLED);

        // Reset and test empty array
        graph.resetGraph();
        await graph.run({ items: [], value: 100 });

        expect(hasItemsTask.status).toBe(TaskStatus.DISABLED);
        expect(emptyTask.status).toBe(TaskStatus.COMPLETED);
      });

      it("should handle deeply nested object conditions", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "deep",
              condition: (i: any) => i.level1?.level2?.level3?.value === "found",
              outputPort: "deep",
            },
            {
              id: "shallow",
              condition: (i: any) => i.level1?.level2?.level3?.value !== "found",
              outputPort: "shallow",
            },
          ],
        });

        const deepTask = new TrackingTask({ id: "deep" });
        const shallowTask = new TrackingTask({ id: "shallow" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, deepTask, shallowTask]);

        graph.addDataflow(new Dataflow(conditional.id, "deep", deepTask.id, "input"));
        graph.addDataflow(new Dataflow(conditional.id, "shallow", shallowTask.id, "input"));

        await graph.run({
          level1: {
            level2: {
              level3: { value: "found" },
            },
          },
        });

        expect(deepTask.status).toBe(TaskStatus.COMPLETED);
        expect(shallowTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("Error Recovery Patterns", () => {
      it("should allow retry path on specific error conditions", async () => {
        const errorRouter = new ConditionalTask({
          id: "errorRouter",
          branches: [
            {
              id: "retry",
              condition: (i: any) => i.errorCode === "TIMEOUT" || i.errorCode === "RATE_LIMIT",
              outputPort: "retry",
            },
            { id: "fail", condition: (i: any) => i.errorCode === "FATAL", outputPort: "fail" },
            { id: "success", condition: (i: any) => !i.errorCode, outputPort: "success" },
          ],
        });

        const retryTask = new ProcessValueTask({ id: "retry" });
        const failTask = new TrackingTask({ id: "fail" });
        const successTask = new ProcessValueTask({ id: "success" });

        const graph = new TaskGraph();
        graph.addTasks([errorRouter, retryTask, failTask, successTask]);

        graph.addDataflow(new Dataflow(errorRouter.id, "retry", retryTask.id, "*"));
        graph.addDataflow(new Dataflow(errorRouter.id, "fail", failTask.id, "input"));
        graph.addDataflow(new Dataflow(errorRouter.id, "success", successTask.id, "*"));

        // Test retry scenario
        await graph.run({ errorCode: "TIMEOUT", value: 1 });
        expect(retryTask.status).toBe(TaskStatus.COMPLETED);
        expect(failTask.status).toBe(TaskStatus.DISABLED);
        expect(successTask.status).toBe(TaskStatus.DISABLED);

        // Test success scenario
        graph.resetGraph();
        await graph.run({ value: 100 });
        expect(retryTask.status).toBe(TaskStatus.DISABLED);
        expect(failTask.status).toBe(TaskStatus.DISABLED);
        expect(successTask.status).toBe(TaskStatus.COMPLETED);
      });
    });

    describe("Complex Multi-Conditional Pipelines", () => {
      it("should handle three sequential conditionals", async () => {
        // First conditional: check if value is positive
        const cond1 = new ConditionalTask({
          id: "cond1",
          branches: [
            { id: "positive", condition: (i: any) => i.value > 0, outputPort: "positive" },
            { id: "nonPositive", condition: (i: any) => i.value <= 0, outputPort: "nonPositive" },
          ],
        });

        // Second conditional: check if positive value is even
        const cond2 = new ConditionalTask({
          id: "cond2",
          branches: [
            {
              id: "even",
              condition: (i: any) => i.positive?.value % 2 === 0,
              outputPort: "even",
            },
            { id: "odd", condition: (i: any) => i.positive?.value % 2 !== 0, outputPort: "odd" },
          ],
        });

        // Third conditional: check if even value is large
        const cond3 = new ConditionalTask({
          id: "cond3",
          branches: [
            {
              id: "large",
              condition: (i: any) => i.even?.positive?.value > 100,
              outputPort: "large",
            },
            {
              id: "small",
              condition: (i: any) => i.even?.positive?.value <= 100,
              outputPort: "small",
            },
          ],
        });

        const largeTask = new ProcessValueTask({ id: "large" });
        const smallTask = new ProcessValueTask({ id: "small" });
        const oddTask = new TrackingTask({ id: "odd" });
        const nonPositiveTask = new TrackingTask({ id: "nonPositive" });

        const graph = new TaskGraph();
        graph.addTasks([cond1, cond2, cond3, largeTask, smallTask, oddTask, nonPositiveTask]);

        // Wire up the pipeline
        graph.addDataflow(new Dataflow(cond1.id, "positive", cond2.id, "positive"));
        graph.addDataflow(new Dataflow(cond1.id, "nonPositive", nonPositiveTask.id, "input"));
        graph.addDataflow(new Dataflow(cond2.id, "even", cond3.id, "even"));
        graph.addDataflow(new Dataflow(cond2.id, "odd", oddTask.id, "input"));
        graph.addDataflow(new Dataflow(cond3.id, "large", largeTask.id, "*"));
        graph.addDataflow(new Dataflow(cond3.id, "small", smallTask.id, "*"));

        // Test: positive (200) -> even -> large
        await graph.run({ value: 200 });

        expect(cond1.isBranchActive("positive")).toBe(true);
        expect(cond2.isBranchActive("even")).toBe(true);
        expect(cond3.isBranchActive("large")).toBe(true);
        expect(largeTask.status).toBe(TaskStatus.COMPLETED);
        expect(smallTask.status).toBe(TaskStatus.DISABLED);
        expect(oddTask.status).toBe(TaskStatus.DISABLED);
        expect(nonPositiveTask.status).toBe(TaskStatus.DISABLED);
      });
    });

    describe("ProcessValueTask Output Verification", () => {
      it("should process values correctly through conditional branches with different transformations", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "multiply",
              condition: (i: any) => i.operation === "multiply",
              outputPort: "multiply",
            },
            {
              id: "divide",
              condition: (i: any) => i.operation === "divide",
              outputPort: "divide",
            },
            {
              id: "process",
              condition: (i: any) => i.operation === "process",
              outputPort: "process",
            },
          ],
        });

        const doubleTask = new DoubleTask({ id: "double" });
        const halveTask = new HalveTask({ id: "halve" });
        const processTask = new ProcessValueTask({ id: "process" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, doubleTask, halveTask, processTask]);

        graph.addDataflow(new Dataflow(conditional.id, "multiply", doubleTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "divide", halveTask.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "process", processTask.id, "*"));

        // Test multiply path
        await graph.run({ operation: "multiply", value: 25 });
        expect(doubleTask.status).toBe(TaskStatus.COMPLETED);
        expect(doubleTask.runOutputData.doubled).toBe(50);
        expect(halveTask.status).toBe(TaskStatus.DISABLED);
        expect(processTask.status).toBe(TaskStatus.DISABLED);

        // Reset and test divide path
        graph.resetGraph();
        await graph.run({ operation: "divide", value: 100 });
        expect(doubleTask.status).toBe(TaskStatus.DISABLED);
        expect(halveTask.status).toBe(TaskStatus.COMPLETED);
        expect(halveTask.runOutputData.halved).toBe(50);
        expect(processTask.status).toBe(TaskStatus.DISABLED);

        // Reset and test process path
        graph.resetGraph();
        await graph.run({ operation: "process", value: 77 });
        expect(doubleTask.status).toBe(TaskStatus.DISABLED);
        expect(halveTask.status).toBe(TaskStatus.DISABLED);
        expect(processTask.status).toBe(TaskStatus.COMPLETED);
        expect(processTask.runOutputData.result).toBe("processed-77");
      });

      it("should verify ProcessValueTask output format for different inputs", async () => {
        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            { id: "zero", condition: (i: any) => i.value === 0, outputPort: "zero" },
            { id: "negative", condition: (i: any) => i.value < 0, outputPort: "negative" },
            { id: "positive", condition: (i: any) => i.value > 0, outputPort: "positive" },
          ],
        });

        const zeroProcessor = new ProcessValueTask({ id: "zeroProcessor" });
        const negativeProcessor = new ProcessValueTask({ id: "negativeProcessor" });
        const positiveProcessor = new ProcessValueTask({ id: "positiveProcessor" });

        const graph = new TaskGraph();
        graph.addTasks([conditional, zeroProcessor, negativeProcessor, positiveProcessor]);

        graph.addDataflow(new Dataflow(conditional.id, "zero", zeroProcessor.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "negative", negativeProcessor.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "positive", positiveProcessor.id, "*"));

        // Test zero
        await graph.run({ value: 0 });
        expect(zeroProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(zeroProcessor.runOutputData.result).toBe("processed-0");

        // Test negative
        graph.resetGraph();
        await graph.run({ value: -42 });
        expect(negativeProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(negativeProcessor.runOutputData.result).toBe("processed--42");

        // Test positive
        graph.resetGraph();
        await graph.run({ value: 123 });
        expect(positiveProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(positiveProcessor.runOutputData.result).toBe("processed-123");
      });
    });

    describe("Concurrent Branch Activation with ProcessValueTask", () => {
      it("should run multiple ProcessValueTasks concurrently in multi-path mode", async () => {
        const fanOut = new ConditionalTask({
          id: "fanOut",
          branches: [
            { id: "proc1", condition: () => true, outputPort: "proc1" },
            { id: "proc2", condition: () => true, outputPort: "proc2" },
          ],
          exclusive: false,
        });

        const processor1 = new ProcessValueTask({ id: "processor1" });
        const processor2 = new ProcessValueTask({ id: "processor2" });

        const graph = new TaskGraph();
        graph.addTasks([fanOut, processor1, processor2]);

        graph.addDataflow(new Dataflow(fanOut.id, "proc1", processor1.id, "*"));
        graph.addDataflow(new Dataflow(fanOut.id, "proc2", processor2.id, "*"));

        await graph.run({ value: 999 });

        // Both should complete
        expect(processor1.status).toBe(TaskStatus.COMPLETED);
        expect(processor2.status).toBe(TaskStatus.COMPLETED);
        expect(processor1.runOutputData.result).toBe("processed-999");
        expect(processor2.runOutputData.result).toBe("processed-999");
      });

      it("should selectively run ProcessValueTasks based on conditions in multi-path mode", async () => {
        const multiPath = new ConditionalTask({
          id: "multiPath",
          branches: [
            { id: "evenPath", condition: (i: any) => i.value % 2 === 0, outputPort: "even" },
            { id: "divisibleBy3", condition: (i: any) => i.value % 3 === 0, outputPort: "div3" },
            { id: "divisibleBy5", condition: (i: any) => i.value % 5 === 0, outputPort: "div5" },
          ],
          exclusive: false,
        });

        const evenProcessor = new ProcessValueTask({ id: "evenProcessor" });
        const div3Processor = new ProcessValueTask({ id: "div3Processor" });
        const div5Processor = new ProcessValueTask({ id: "div5Processor" });

        const graph = new TaskGraph();
        graph.addTasks([multiPath, evenProcessor, div3Processor, div5Processor]);

        graph.addDataflow(new Dataflow(multiPath.id, "even", evenProcessor.id, "*"));
        graph.addDataflow(new Dataflow(multiPath.id, "div3", div3Processor.id, "*"));
        graph.addDataflow(new Dataflow(multiPath.id, "div5", div5Processor.id, "*"));

        // Test value 30 (divisible by 2, 3, and 5)
        await graph.run({ value: 30 });
        expect(evenProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(div3Processor.status).toBe(TaskStatus.COMPLETED);
        expect(div5Processor.status).toBe(TaskStatus.COMPLETED);

        // Test value 9 (divisible by 3 only, odd)
        graph.resetGraph();
        await graph.run({ value: 9 });
        expect(evenProcessor.status).toBe(TaskStatus.DISABLED);
        expect(div3Processor.status).toBe(TaskStatus.COMPLETED);
        expect(div5Processor.status).toBe(TaskStatus.DISABLED);

        // Test value 10 (divisible by 2 and 5)
        graph.resetGraph();
        await graph.run({ value: 10 });
        expect(evenProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(div3Processor.status).toBe(TaskStatus.DISABLED);
        expect(div5Processor.status).toBe(TaskStatus.COMPLETED);
      });
    });

    describe("Edge Cases with Numeric Operations", () => {
      it("should handle DoubleTask -> ConditionalTask -> ProcessValueTask with boundary values", async () => {
        const doubler = new DoubleTask({ id: "doubler" });

        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "overflow",
              condition: (i: any) => i.doubled > 1000000,
              outputPort: "overflow",
            },
            { id: "normal", condition: (i: any) => i.doubled <= 1000000, outputPort: "normal" },
          ],
        });

        const overflowProcessor = new ProcessValueTask({ id: "overflow" });
        const normalProcessor = new ProcessValueTask({ id: "normal" });

        const graph = new TaskGraph();
        graph.addTasks([doubler, conditional, overflowProcessor, normalProcessor]);

        graph.addDataflow(new Dataflow(doubler.id, "doubled", conditional.id, "doubled"));
        graph.addDataflow(new Dataflow(conditional.id, "overflow", overflowProcessor.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "normal", normalProcessor.id, "*"));

        // Test overflow path (500001 * 2 = 1000002)
        await graph.run({ value: 500001 });
        expect(doubler.runOutputData.doubled).toBe(1000002);
        expect(overflowProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(normalProcessor.status).toBe(TaskStatus.DISABLED);

        // Test normal path (500000 * 2 = 1000000)
        graph.resetGraph();
        await graph.run({ value: 500000 });
        expect(doubler.runOutputData.doubled).toBe(1000000);
        expect(overflowProcessor.status).toBe(TaskStatus.DISABLED);
        expect(normalProcessor.status).toBe(TaskStatus.COMPLETED);
      });

      it("should handle HalveTask -> ConditionalTask -> ProcessValueTask with decimal results", async () => {
        const halver = new HalveTask({ id: "halver" });

        const conditional = new ConditionalTask({
          id: "conditional",
          branches: [
            {
              id: "integer",
              condition: (i: any) => Number.isInteger(i.halved),
              outputPort: "integer",
            },
            {
              id: "decimal",
              condition: (i: any) => !Number.isInteger(i.halved),
              outputPort: "decimal",
            },
          ],
        });

        const integerProcessor = new ProcessValueTask({ id: "integer" });
        const decimalProcessor = new ProcessValueTask({ id: "decimal" });

        const graph = new TaskGraph();
        graph.addTasks([halver, conditional, integerProcessor, decimalProcessor]);

        graph.addDataflow(new Dataflow(halver.id, "halved", conditional.id, "halved"));
        graph.addDataflow(new Dataflow(conditional.id, "integer", integerProcessor.id, "*"));
        graph.addDataflow(new Dataflow(conditional.id, "decimal", decimalProcessor.id, "*"));

        // Test integer result (100 / 2 = 50)
        await graph.run({ value: 100 });
        expect(halver.runOutputData.halved).toBe(50);
        expect(integerProcessor.status).toBe(TaskStatus.COMPLETED);
        expect(decimalProcessor.status).toBe(TaskStatus.DISABLED);

        // Test decimal result (99 / 2 = 49.5)
        graph.resetGraph();
        await graph.run({ value: 99 });
        expect(halver.runOutputData.halved).toBe(49.5);
        expect(integerProcessor.status).toBe(TaskStatus.DISABLED);
        expect(decimalProcessor.status).toBe(TaskStatus.COMPLETED);
      });
    });

    describe("Dynamic Schemas", () => {
      it("should have hasDynamicSchemas set to true", () => {
        expect((ConditionalTask as any).hasDynamicSchemas).toBe(true);
      });

      it("should emit schemaChange event when emitSchemaChange is called", () => {
        const task = new ConditionalTask({
          branches: [
            { id: "branch1", condition: () => true, outputPort: "port1" },
            { id: "branch2", condition: () => false, outputPort: "port2" },
          ],
        });

        let schemaChangeEmitted = false;
        let receivedInputSchema: DataPortSchema | undefined;
        let receivedOutputSchema: DataPortSchema | undefined;

        task.on("schemaChange", (inputSchema?: DataPortSchema, outputSchema?: DataPortSchema) => {
          schemaChangeEmitted = true;
          receivedInputSchema = inputSchema;
          receivedOutputSchema = outputSchema;
        });

        // @ts-expect-error - emitSchemaChange is protected
        task.emitSchemaChange();

        expect(schemaChangeEmitted).toBe(true);
        expect(receivedInputSchema).toBeDefined();
        expect(receivedOutputSchema).toBeDefined();
        expect(receivedOutputSchema).toHaveProperty("properties");
        if (typeof receivedOutputSchema === "object" && receivedOutputSchema !== null) {
          expect(receivedOutputSchema.properties).toHaveProperty("port1");
          expect(receivedOutputSchema.properties).toHaveProperty("port2");
        }
      });

      it("should emit schemaChange event with provided schemas", () => {
        const task = new ConditionalTask({
          branches: [{ id: "branch1", condition: () => true, outputPort: "port1" }],
        });

        let receivedInputSchema: DataPortSchema | undefined;
        let receivedOutputSchema: DataPortSchema | undefined;

        task.on("schemaChange", (inputSchema?: DataPortSchema, outputSchema?: DataPortSchema) => {
          receivedInputSchema = inputSchema;
          receivedOutputSchema = outputSchema;
        });

        const customInputSchema: DataPortSchema = {
          type: "object",
          properties: { custom: { type: "string" } },
        };
        const customOutputSchema: DataPortSchema = {
          type: "object",
          properties: { customOut: { type: "string" } },
        };

        // @ts-expect-error - emitSchemaChange is protected
        task.emitSchemaChange(customInputSchema, customOutputSchema);

        expect(receivedInputSchema).toEqual(customInputSchema);
        expect(receivedOutputSchema).toEqual(customOutputSchema);
      });

      it("should have different output schemas for different branch configurations", () => {
        const task1 = new ConditionalTask({
          branches: [
            { id: "a", condition: () => true, outputPort: "outputA" },
            { id: "b", condition: () => false, outputPort: "outputB" },
          ],
        });

        const task2 = new ConditionalTask({
          branches: [
            { id: "x", condition: () => true, outputPort: "outputX" },
            { id: "y", condition: () => false, outputPort: "outputY" },
            { id: "z", condition: () => false, outputPort: "outputZ" },
          ],
        });

        const schema1 = task1.outputSchema();
        const schema2 = task2.outputSchema();

        expect(schema1).not.toEqual(schema2);
        if (typeof schema1 === "object" && schema1 !== null && "properties" in schema1) {
          expect(schema1.properties).toHaveProperty("outputA");
          expect(schema1.properties).toHaveProperty("outputB");
          expect(schema1.properties).not.toHaveProperty("outputX");
        }
        if (typeof schema2 === "object" && schema2 !== null && "properties" in schema2) {
          expect(schema2.properties).toHaveProperty("outputX");
          expect(schema2.properties).toHaveProperty("outputY");
          expect(schema2.properties).toHaveProperty("outputZ");
          expect(schema2.properties).not.toHaveProperty("outputA");
        }
      });
    });
  });
});
