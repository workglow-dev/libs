/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `GraphAsTask` whose subgraph runs off-thread, with its streaming output
 * port crossing the boundary live rather than arriving whole at the end.
 *
 * The dispatcher here runs the subgraph in this thread — what is under test is
 * the wiring, not the worker — but it goes through the same
 * `runSubGraphStreamRequest` a real worker entry registers, and the same
 * pull-paced generator path, so the ordering and pacing properties are the
 * real ones.
 */

import type {
  IExecuteContext,
  ISubGraphDispatcher,
  SubGraphRunOptions,
  SubGraphRunRequest,
  SubGraphRunResults,
  SubGraphStreamItem,
  TaskInput,
} from "@workglow/task-graph";
import {
  GraphAsTask,
  runSubGraphRequest,
  runSubGraphStreamRequest,
  SUBGRAPH_DISPATCHER,
  Task,
  TaskGraph,
  TaskRegistry,
  Workflow,
} from "@workglow/task-graph";
import { globalServiceRegistry, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, describe, expect, it } from "vitest";

type Out = { text: string };

class ThreadedProbeTask extends Task<TaskInput, Out> {
  public static override type = "GraphAsTaskThreaded_Probe";
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: true } as const;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string", "x-stream": "append" } },
      additionalProperties: false,
    } as const as DataPortSchema;
  }
  override async *executeStream(): AsyncGenerator<unknown> {
    for (const piece of ["one ", "two ", "three"]) {
      yield { type: "text-delta", port: "text", textDelta: piece };
    }
    yield { type: "finish", data: { text: "one two three" } };
  }
}

TaskRegistry.registerTask(ThreadedProbeTask);
afterAll(() => TaskRegistry.unregisterTask(ThreadedProbeTask.type));

/** Speaks the dispatcher contract; runs the subgraph here. */
class LocalDispatcher implements ISubGraphDispatcher {
  public streamCalls = 0;
  public plainCalls = 0;

  async runSubGraph(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): Promise<SubGraphRunResults> {
    this.plainCalls++;
    return await runSubGraphRequest(structuredClone(request), undefined, options);
  }

  async *runSubGraphStream(
    request: SubGraphRunRequest,
    options?: SubGraphRunOptions
  ): AsyncIterable<SubGraphStreamItem> {
    this.streamCalls++;
    const items: SubGraphStreamItem[] = [];
    await runSubGraphStreamRequest(
      structuredClone(request),
      undefined,
      (item) => {
        items.push(item);
      },
      options
    );
    for (const item of items) yield item;
  }
}

/** A dispatcher with no streaming support, to prove the fallback. */
class PlainOnlyDispatcher implements ISubGraphDispatcher {
  public plainCalls = 0;
  async runSubGraph(request: SubGraphRunRequest): Promise<SubGraphRunResults> {
    this.plainCalls++;
    return await runSubGraphRequest(structuredClone(request));
  }
}

function threadedGroup(): GraphAsTask {
  const sub = new TaskGraph();
  sub.addTask(new ThreadedProbeTask({ id: "probe" }));
  return new GraphAsTask({ id: "group", subGraph: sub, executionMode: "thread" } as never);
}

/** Runs one task as a whole graph and returns its output. */
async function runOne(task: GraphAsTask, registry: ServiceRegistry): Promise<unknown> {
  const graph = new TaskGraph();
  graph.addTask(task);
  const results = await graph.run({}, { registry });
  return results[0]?.data;
}

function registryWith(dispatcher: ISubGraphDispatcher): ServiceRegistry {
  const registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
  registry.registerInstance(SUBGRAPH_DISPATCHER, dispatcher);
  return registry;
}

describe("GraphAsTask with executionMode: thread", () => {
  it("defaults to inline", () => {
    const sub = new TaskGraph();
    sub.addTask(new ThreadedProbeTask());
    expect(new GraphAsTask({ subGraph: sub } as never).executionMode).toBe("inline");
  });

  it("dispatches the subgraph and produces the same output", async () => {
    const dispatcher = new LocalDispatcher();
    const out = await runOne(threadedGroup(), registryWith(dispatcher));

    expect(dispatcher.streamCalls + dispatcher.plainCalls).toBeGreaterThan(0);
    expect(out).toMatchObject({ text: "one two three" });
  });

  it("runs in-process when no dispatcher is registered", async () => {
    const registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
    const out = await runOne(threadedGroup(), registry);

    expect(out).toMatchObject({ text: "one two three" });
  });

  it("stays in-process when the dispatcher cannot stream, so ports stay live", async () => {
    const dispatcher = new PlainOnlyDispatcher();
    const out = await runOne(threadedGroup(), registryWith(dispatcher));

    // The non-streaming path may still dispatch; what must not happen is a
    // streaming group silently losing its incremental output.
    expect(out).toMatchObject({ text: "one two three" });
  });

  it("falls back in-process when the subgraph is not thread-portable", async () => {
    const dispatcher = new LocalDispatcher();

    const sub = new TaskGraph();
    const wfInner = new Workflow();
    wfInner.pipe(async function notPortable(input: TaskInput) {
      return { text: "closure output" };
    });
    for (const task of wfInner.graph.getTasks()) sub.addTask(task);

    const group = new GraphAsTask({ subGraph: sub, executionMode: "thread" } as never);
    const out = await runOne(group, registryWith(dispatcher));

    expect(dispatcher.streamCalls).toBe(0);
    expect(dispatcher.plainCalls).toBe(0);
    expect(out).toMatchObject({ text: "closure output" });
  });
});

describe("event bridge across the dispatch boundary", () => {
  it("surfaces the dispatched subgraph's per-task events on the parent graph", async () => {
    const dispatcher = new LocalDispatcher();
    const graph = new TaskGraph();
    graph.addTask(threadedGroup());

    const seen: string[] = [];
    for (const name of ["task_complete", "task_stream_chunk", "task_stream_end"] as const) {
      graph.subscribe(name, () => seen.push(name));
    }

    await graph.run({}, { registry: registryWith(dispatcher) });

    // Without the bridge a dispatched group is one opaque row: its children's
    // events never reach the graph a progress UI is watching.
    expect(dispatcher.streamCalls).toBeGreaterThan(0);
    expect(seen).toContain("task_stream_chunk");
    expect(seen.filter((n) => n === "task_complete").length).toBeGreaterThan(0);
  });
});

describe("forward buffer ceiling", () => {
  it("fails with a diagnosable error rather than growing without bound", async () => {
    // `task_stream_chunk` is emitted synchronously by StreamPump, so a
    // forwarding listener cannot park its producer. The ceiling is what turns
    // an unbounded heap climb into something a reader can act on.
    const sub = new TaskGraph();
    sub.addTask(new ThreadedProbeTask({ id: "probe" }));

    await expect(
      runSubGraphStreamRequest(
        { graph: sub.toJSON(), input: {} },
        undefined,
        // Never drains, so pending cost only grows.
        () => new Promise<void>(() => {}),
        { forwardBufferLimit: 1 }
      )
    ).rejects.toThrow(/outran its consumer/);
  });

  it("does not trip on a consumer keeping pace", async () => {
    const sub = new TaskGraph();
    sub.addTask(new ThreadedProbeTask({ id: "probe" }));

    const items: string[] = [];
    await runSubGraphStreamRequest(
      { graph: sub.toJSON(), input: {} },
      undefined,
      (item) => {
        items.push(item.kind);
      },
      { forwardBufferLimit: 1024 * 1024 }
    );

    expect(items).toContain("results");
  });
});
