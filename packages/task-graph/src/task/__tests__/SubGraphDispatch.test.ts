/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  ISubGraphDispatcher,
  SubGraphRunOptions,
  SubGraphRunRequest,
  SubGraphRunResults,
  TaskInput,
} from "@workglow/task-graph";
import {
  MapTask,
  runSubGraphRequest,
  SUBGRAPH_DISPATCHER,
  Task,
  TaskRegistry,
  Workflow,
} from "@workglow/task-graph";
import { globalServiceRegistry, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

type DoubleIn = { value: number };
type DoubleOut = { doubled: number };

/** A registered, plain-config task — the shape a threaded subgraph body must have. */
class DoubleTask extends Task<DoubleIn, DoubleOut> {
  public static override type = "SubGraphDispatch_Double";
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { value: { type: "number" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { doubled: { type: "number" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute(input: DoubleIn, context: IExecuteContext): Promise<DoubleOut> {
    await context.updateProgress(50, "halfway");
    return { doubled: (input.value ?? 0) * 2 };
  }
}

TaskRegistry.registerTask(DoubleTask);
afterAll(() => {
  TaskRegistry.unregisterTask(DoubleTask.type);
});

/**
 * Stands in for a worker. Runs the request in this thread through the same
 * entry a real worker entry would register, which is what lets the runner's
 * threaded path be tested without spawning one.
 */
class InlineDispatcher implements ISubGraphDispatcher {
  public readonly requests: SubGraphRunRequest[] = [];
  public readonly progress: Array<number | undefined> = [];

  async runSubGraph(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): Promise<SubGraphRunResults> {
    // Proves the request survived the boundary it claims to describe.
    const wire = structuredClone(request);
    this.requests.push(wire);
    return await runSubGraphRequest(wire, undefined, {
      signal: options?.signal,
      onProgress: (p) => {
        this.progress.push(p);
        options?.onProgress?.(p);
      },
    });
  }
}

/** A dispatcher that must never be called. */
class ExplodingDispatcher implements ISubGraphDispatcher {
  public called = false;
  async runSubGraph(): Promise<SubGraphRunResults> {
    this.called = true;
    throw new Error("dispatcher should not have been used");
  }
}

function mapWorkflow(concurrencyMode: "inline" | "thread", body: () => void): Workflow {
  const wf = new Workflow();
  const loop = wf.map({ maxIterations: "unbounded", concurrencyMode, preserveOrder: true });
  body();
  return wf;
}

describe("runSubGraphRequest", () => {
  it("rebuilds a graph from JSON and runs it", async () => {
    const wf = new Workflow();
    wf.pipe(new DoubleTask());

    const results = await runSubGraphRequest({ graph: wf.graph.toJSON(), input: { value: 21 } });
    expect(results.length).toBeGreaterThan(0);
    // One entry per leaf task: { id, type, data }. The parent merges these.
    expect(results[0]).toMatchObject({ type: DoubleTask.type, data: { doubled: 42 } });
  });

  it("forwards graph progress to the caller", async () => {
    const wf = new Workflow();
    wf.pipe(new DoubleTask());

    const seen: Array<number | undefined> = [];
    await runSubGraphRequest({ graph: wf.graph.toJSON(), input: { value: 1 } }, undefined, {
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("IteratorTaskRunner threaded dispatch", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
  });

  afterEach(() => {
    // Nothing global was mutated; the child registry is discarded with the test.
  });

  it("dispatches each iteration when a dispatcher is registered", async () => {
    const dispatcher = new InlineDispatcher();
    registry.registerInstance(SUBGRAPH_DISPATCHER, dispatcher);

    const wf = new Workflow();
    const loop = wf.map({
      maxIterations: "unbounded",
      concurrencyMode: "thread",
      preserveOrder: true,
    });
    loop.pipe(new DoubleTask());
    loop.endMap();

    const out = await wf.run({ value: [1, 2, 3] }, { registry });

    expect(dispatcher.requests).toHaveLength(3);
    expect(out).toMatchObject({ doubled: [2, 4, 6] });
  });

  it("runs in-process when no dispatcher is registered, with the same answer", async () => {
    const wf = new Workflow();
    const loop = wf.map({
      maxIterations: "unbounded",
      concurrencyMode: "thread",
      preserveOrder: true,
    });
    loop.pipe(new DoubleTask());
    loop.endMap();

    // No SUBGRAPH_DISPATCHER bound: threading is an optimization, so this must
    // still produce the result rather than fail.
    const out = await wf.run({ value: [4, 5] }, { registry });
    expect(out).toMatchObject({ doubled: [8, 10] });
  });

  it("never dispatches when the mode is left at its default", async () => {
    const dispatcher = new ExplodingDispatcher();
    registry.registerInstance(SUBGRAPH_DISPATCHER, dispatcher);

    const wf = new Workflow();
    const loop = wf.map({ maxIterations: "unbounded", preserveOrder: true });
    loop.pipe(new DoubleTask());
    loop.endMap();

    const out = await wf.run({ value: [7] }, { registry });
    expect(dispatcher.called).toBe(false);
    expect(out).toMatchObject({ doubled: [14] });
  });

  it("falls back in-process when the subgraph is not thread-portable", async () => {
    const dispatcher = new ExplodingDispatcher();
    registry.registerInstance(SUBGRAPH_DISPATCHER, dispatcher);

    const wf = new Workflow();
    const loop = wf.map({
      maxIterations: "unbounded",
      concurrencyMode: "thread",
      preserveOrder: true,
    });
    // A piped closure: serializes cleanly, names a type no registry holds.
    loop.pipe(async function notPortable(input: TaskInput) {
      return { doubled: ((input as DoubleIn).value ?? 0) * 2 };
    });
    loop.endMap();

    const out = await wf.run({ value: [3] }, { registry });

    // The dispatcher was refused by the gate rather than handed a graph it
    // could not rebuild — and the run still produced the right answer.
    expect(dispatcher.called).toBe(false);
    expect(out).toMatchObject({ doubled: [6] });
  });
});

describe("MapTask config", () => {
  it("defaults concurrencyMode to inline", () => {
    const task = new MapTask({ maxIterations: 1 });
    expect(task.concurrencyMode).toBe("inline");
  });

  it("carries concurrencyMode through serialization", () => {
    const task = new MapTask({ maxIterations: 1, concurrencyMode: "thread" });
    expect(task.concurrencyMode).toBe("thread");
    expect(task.toJSON().config).toMatchObject({ concurrencyMode: "thread" });
  });
});

describe("run options crossing the boundary", () => {
  it("carries the serializable run config, so semantics do not change with location", async () => {
    const seen: SubGraphRunRequest[] = [];
    const dispatcher: ISubGraphDispatcher = {
      async runSubGraph(request) {
        seen.push(structuredClone(request));
        return await runSubGraphRequest(request);
      },
    };

    const registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
    registry.registerInstance(SUBGRAPH_DISPATCHER, dispatcher);

    const wf = new Workflow();
    const loop = wf.map({
      maxIterations: "unbounded",
      concurrencyMode: "thread",
      preserveOrder: true,
    });
    loop.pipe(new DoubleTask());
    loop.endMap();

    await wf.run({ value: [1] }, { registry });

    expect(seen).toHaveLength(1);
    // The slice is built and sent. Dropping it entirely — which is what the
    // dispatch sites did before — would give a threaded subgraph different
    // streaming and entitlement semantics than the same graph run inline.
    //
    // Asserts the shape rather than specific values: what a nested runner
    // resolves for `noAccumulation` is separate framework behaviour (a
    // graph-level run config does not reach a nested task's runner), and
    // pinning it here would be testing propagation this change did not touch.
    const runOptions = seen[0]!.runOptions;
    expect(runOptions).toBeDefined();
    expect(Object.keys(runOptions!)).toEqual(
      expect.arrayContaining(["enforceEntitlements", "noAccumulation"])
    );
  });

  it("survives structuredClone, which is the only contract a dispatcher has", () => {
    const wf = new Workflow();
    wf.pipe(new DoubleTask());
    const request: SubGraphRunRequest = {
      graph: wf.graph.toJSON(),
      input: { value: 1 },
      runOptions: { enforceEntitlements: true, noAccumulation: false, streamHighWaterBytes: 10 },
    };
    expect(() => structuredClone(request)).not.toThrow();
    expect(structuredClone(request).runOptions).toEqual(request.runOptions);
  });
});
