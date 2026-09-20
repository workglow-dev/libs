/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskInput } from "@workglow/task-graph";
import {
  Task,
  TaskGraph,
  TaskRegistry,
  taskGraphThreadPortabilityError,
  validateThreadPortability,
  WhileTask,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, describe, expect, it } from "vitest";

type Out = { text: string };

const EMPTY_IN = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies DataPortSchema;

const TEXT_OUT = {
  type: "object",
  properties: { text: { type: "string" } },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/** A perfectly ordinary task: registered, and its config is plain data. */
class PortableTask extends Task<TaskInput, Out> {
  public static override type = "ThreadPortability_Portable";
  public static override inputSchema(): DataPortSchema {
    return EMPTY_IN;
  }
  public static override outputSchema(): DataPortSchema {
    return TEXT_OUT;
  }
  override async execute(): Promise<Out> {
    return { text: "ok" };
  }
}

/** Serializes fine, but no thread that did not declare it could rebuild it. */
class UnregisteredTask extends Task<TaskInput, Out> {
  public static override type = "ThreadPortability_Unregistered";
  public static override inputSchema(): DataPortSchema {
    return EMPTY_IN;
  }
  public static override outputSchema(): DataPortSchema {
    return TEXT_OUT;
  }
  override async execute(): Promise<Out> {
    return { text: "ok" };
  }
}

/** Registered, but declares its own config unserializable the way LambdaTask does. */
class ClosureConfigTask extends Task<TaskInput, Out> {
  public static override type = "ThreadPortability_ClosureConfig";
  public static override inputSchema(): DataPortSchema {
    return EMPTY_IN;
  }
  public static override outputSchema(): DataPortSchema {
    return TEXT_OUT;
  }
  public override canSerializeConfig(): boolean {
    return false;
  }
  override async execute(): Promise<Out> {
    return { text: "ok" };
  }
}

TaskRegistry.registerTask(PortableTask);
TaskRegistry.registerTask(ClosureConfigTask);

afterAll(() => {
  TaskRegistry.unregisterTask(PortableTask.type);
  TaskRegistry.unregisterTask(ClosureConfigTask.type);
});

function graphOf(...tasks: Task<any, any, any>[]): TaskGraph {
  const graph = new TaskGraph();
  for (const task of tasks) graph.addTask(task);
  return graph;
}

describe("taskGraphThreadPortabilityError", () => {
  it("accepts an empty graph", () => {
    expect(taskGraphThreadPortabilityError(new TaskGraph())).toBeUndefined();
  });

  it("accepts a graph of registered, plain-config tasks", () => {
    const graph = graphOf(new PortableTask({ id: "a" }), new PortableTask({ id: "b" }));
    expect(taskGraphThreadPortabilityError(graph)).toBeUndefined();
  });

  it("names the task whose type the receiving thread could not rebuild", () => {
    const graph = graphOf(new PortableTask({ id: "fine" }), new UnregisteredTask({ id: "nope" }));
    const reason = taskGraphThreadPortabilityError(graph);
    expect(reason).toContain('"nope"');
    expect(reason).toContain("not a registered task type");
  });

  it("names the task that declares its config unserializable", () => {
    const graph = graphOf(new ClosureConfigTask({ id: "lambda-ish" }));
    const reason = taskGraphThreadPortabilityError(graph);
    expect(reason).toContain('"lambda-ish"');
    expect(reason).toContain("canSerializeConfig");
  });

  it("rejects a WhileTask whose condition was given as a function", () => {
    // The case the whole check exists for: `cloneGraph` keeps this working
    // in-process, and a thread cannot — the function is not in the JSON.
    const graph = graphOf(
      new WhileTask({ id: "loop", maxIterations: 1, condition: () => false } as any)
    );
    expect(taskGraphThreadPortabilityError(graph)).toContain('"loop"');
  });

  it("looks inside nested subgraphs rather than only at the top level", () => {
    const parent = new PortableTask({ id: "parent" });
    parent.subGraph = graphOf(new UnregisteredTask({ id: "buried" }));
    const reason = taskGraphThreadPortabilityError(graphOf(parent));
    expect(reason).toContain('"buried"');
  });

  it("rejects a workflow built with pipe(fn), which serializes cleanly and cannot be rebuilt", () => {
    // The dominant real-world case, and the reason the registry half of this
    // check exists. `pipe(fn)` mints a fresh anonymous subclass whose `type` is
    // derived from the function name and whose closure lives in the class body
    // rather than in config — so `canSerializeConfig()` is true, `toJSON()`
    // succeeds, and the JSON names a type no registry has ever heard of. The
    // failure would otherwise land inside the worker.
    const wf = new Workflow();
    wf.pipe(async function myPipedStep(input: TaskInput) {
      return input;
    });

    const reason = taskGraphThreadPortabilityError(wf.graph);
    expect(reason).toContain("myPipedStep");
    expect(reason).toContain("not a registered task type");
  });

  it("does not treat a childless task as having a subgraph", () => {
    // `subGraph` materializes an empty graph on access, so a check that read it
    // directly would walk a level per node and never terminate on a deep graph.
    const task = new PortableTask({ id: "solo" });
    expect(task.hasChildren()).toBe(false);
    expect(taskGraphThreadPortabilityError(graphOf(task))).toBeUndefined();
  });
});

describe("validateThreadPortability", () => {
  it("narrows to ok for a portable graph", () => {
    const result = validateThreadPortability(graphOf(new PortableTask({ id: "a" })));
    expect(result.ok).toBe(true);
  });

  it("carries the reason when the graph is not portable", () => {
    const result = validateThreadPortability(graphOf(new ClosureConfigTask({ id: "x" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('"x"');
  });
});
