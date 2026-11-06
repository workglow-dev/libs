/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConditionalTask, Task, Workflow, WorkflowError } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

import { DoubleToDoubledTask, HalveTask } from "@workglow/task-graph/test";
import { getTestingLogger } from "@workglow/util/test";

/** Echoes its `value` input back out, used to drive a conditional's predicate from upstream. */
class ValueSourceTask extends Task<{ value: number }, { value: number }> {
  static override type = "ValueSourceTask";
  static override category = "Test";
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { value: { type: "number" } },
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { value: { type: "number" } },
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { value: number }): Promise<{ value: number }> {
    return { value: input.value };
  }
}

/** Consumes a `doubled` input, so it auto-connects from {@link DoubleToDoubledTask}'s output. */
class DoubledConsumerTask extends Task<{ doubled: number }, { result: number }> {
  static override type = "DoubledConsumerTask";
  static override category = "Test";
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { doubled: { type: "number" } },
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { result: { type: "number" } },
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { doubled: number }): Promise<{ result: number }> {
    return { result: input.doubled };
  }
}

describe("ConditionalBuilder (Workflow.if)", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  it("creates a ConditionalTask + then-only branch with a wired dataflow", () => {
    const workflow = new Workflow();
    workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    expect(tasks.some((t) => t instanceof ConditionalTask)).toBe(true);
    expect(tasks.some((t) => t instanceof DoubleToDoubledTask)).toBe(true);

    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;
    const thenTask = tasks.find((t) => t instanceof DoubleToDoubledTask)!;

    const dataflows = workflow.graph.getDataflows();
    const thenEdge = dataflows.find(
      (df) => df.sourceTaskId === conditional.id && df.targetTaskId === thenTask.id
    );
    expect(thenEdge).toBeDefined();
    expect(thenEdge!.sourceTaskPortId).toBe("then");
  });

  it("creates then + else branches with both dataflows wired", () => {
    const workflow = new Workflow();
    workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;
    const thenTask = tasks.find((t) => t instanceof DoubleToDoubledTask)!;
    const elseTask = tasks.find((t) => t instanceof HalveTask)!;

    const dataflows = workflow.graph.getDataflows();
    const thenEdge = dataflows.find(
      (df) => df.sourceTaskId === conditional.id && df.targetTaskId === thenTask.id
    );
    const elseEdge = dataflows.find(
      (df) => df.sourceTaskId === conditional.id && df.targetTaskId === elseTask.id
    );

    expect(thenEdge?.sourceTaskPortId).toBe("then");
    expect(elseEdge?.sourceTaskPortId).toBe("else");
  });

  it("throws WorkflowError when endIf() is called without then()", () => {
    const workflow = new Workflow();
    const builder = workflow.if((input: any) => input.value > 5);

    expect(() => builder.endIf()).toThrow(WorkflowError);
  });

  it("activates only the then branch when condition matches", async () => {
    const workflow = new Workflow();
    workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;

    await conditional.run({ value: 10 });

    expect(conditional.isBranchActive("then")).toBe(true);
    expect(conditional.isBranchActive("else")).toBe(false);
  });

  it("activates only the else branch when condition does not match", async () => {
    const workflow = new Workflow();
    workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;

    await conditional.run({ value: 3 });

    expect(conditional.isBranchActive("then")).toBe(false);
    expect(conditional.isBranchActive("else")).toBe(true);
  });

  it("fails when the condition throws, rather than taking the else arm", async () => {
    // ConditionalTask fails the task on a throwing condition (as WhileTask does); the
    // builder's else arm must not turn that failure into a route.
    const workflow = new Workflow();
    workflow
      .if(() => {
        throw new Error("boom");
      })
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;

    // The else-branch condition, invoked directly, propagates the underlying error
    // rather than silently returning true.
    const branches = conditional.config.branches!;
    const elseBranch = branches.find((b) => b.id === "else")!;
    expect(() => elseBranch.condition({})).toThrow("boom");

    await expect(conditional.run({})).rejects.toThrow(/branch "then".*boom/);
    expect(conditional.getActiveBranches().size).toBe(0);
  });

  it("with no else arm, a throwing condition fails the task", async () => {
    const workflow = new Workflow();
    workflow
      .if(() => {
        throw new Error("boom");
      })
      .then(DoubleToDoubledTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;

    await expect(conditional.run({})).rejects.toThrow(/boom/);
    expect(conditional.getActiveBranches().size).toBe(0);
  });

  it("wires the prior task's output INTO the conditional input (mid-chain .if)", async () => {
    const workflow = new Workflow();
    workflow
      .addTask(ValueSourceTask, { value: 10 })
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    const tasks = workflow.graph.getTasks();
    const source = tasks.find((t) => t instanceof ValueSourceTask)!;
    const conditional = tasks.find((t) => t instanceof ConditionalTask) as ConditionalTask;

    // An A -> conditional dataflow must exist so the predicate sees A's output.
    const dataflows = workflow.graph.getDataflows();
    const inEdge = dataflows.find(
      (df) => df.sourceTaskId === source.id && df.targetTaskId === conditional.id
    );
    expect(inEdge).toBeDefined();

    // The predicate must observe the upstream value (10 > 5 -> then active).
    let observed: unknown;
    const branches = conditional.config.branches!;
    const original = branches[0].condition;
    (branches[0] as any).condition = (input: any) => {
      observed = input?.value;
      return original(input);
    };

    await workflow.run({ value: 10 });

    expect(observed).toBe(10);
    expect(conditional.isBranchActive("then")).toBe(true);
    expect(conditional.isBranchActive("else")).toBe(false);
  });

  it("throws on .addTask after a two-arm .endIf() (ambiguous join)", () => {
    const workflow = new Workflow();
    const continued = workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .else(HalveTask)
      .endIf();

    expect(() => continued.addTask(ValueSourceTask)).toThrow(WorkflowError);
  });

  it("allows .addTask after a then-only .endIf() (single leaf)", () => {
    const workflow = new Workflow();
    const continued = workflow
      .if((input: any) => input.value > 5)
      .then(DoubleToDoubledTask)
      .endIf();

    // The single then-arm is an unambiguous predecessor, and DoubledConsumerTask
    // auto-connects from its `doubled` output — so continuation must not throw.
    expect(() => continued.addTask(DoubledConsumerTask)).not.toThrow();
  });
});
