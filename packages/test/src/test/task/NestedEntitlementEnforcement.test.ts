/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPolicyEnforcer,
  createScopedEnforcer,
  Dataflow,
  ENTITLEMENT_ENFORCER,
  Entitlements,
  FallbackTask,
  GraphAsTask,
  MapTask,
  ReduceTask,
  Task,
  TaskEntitlementError,
  TaskGraph,
  TaskGraphRunner,
  WhileTask,
  type IEntitlementEnforcer,
  type IExecuteContext,
  type ITask,
  type TaskEntitlements,
} from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchUrlTask } from "../../../../tasks/src/task/FetchUrlTask";
import { registerSafeFetch, type SafeFetchFn } from "../../../../tasks/src/util/SafeFetch";

const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

let previousSafeFetch: SafeFetchFn;
let fetched: string[] = [];

beforeAll(() => {
  // The enforcer is what is under test, not the network layer.
  previousSafeFetch = registerSafeFetch(((url: string) => {
    fetched.push(url);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as SafeFetchFn);
});
afterAll(() => registerSafeFetch(previousSafeFetch));

/**
 * Reaches a private host through a child it takes with `own()`, without
 * declaring anything itself — the shape `FileLoaderTask` had before it started
 * mirroring its child's entitlements.
 */
class OwningFetchTask extends Task<Record<string, unknown>, Record<string, unknown>> {
  public static override type = "OwningFetchTask";
  public static override outputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: true } as DataPortSchema;
  }
  public override async execute(_input: unknown, context: IExecuteContext) {
    const child = context.own(new FetchUrlTask({ id: "owned-fetch" } as never));
    await child.run({ url: METADATA_URL, response_type: "text" });
    return {};
  }
}

function loopbackOnlyRegistry(): ServiceRegistry {
  const enforcer: IEntitlementEnforcer = createScopedEnforcer([
    { id: Entitlements.NETWORK_HTTP },
    { id: Entitlements.CREDENTIAL },
    { id: Entitlements.NETWORK_PRIVATE, resources: ["http://localhost:*/*"] },
  ]);
  const registry = new ServiceRegistry(new Container());
  registry.register(ENTITLEMENT_ENFORCER, () => enforcer);
  return registry;
}

function run(graph: TaskGraph, enforceEntitlements = true) {
  fetched = [];
  return new TaskGraphRunner(graph).runGraph(
    {},
    { registry: loopbackOnlyRegistry(), enforceEntitlements }
  );
}

describe("entitlement enforcement reaches nested work", () => {
  // An owned child runs via `child.run()`, which the graph scheduler never
  // sees. Pre-flight cannot see it either — `own()` happens inside execute(),
  // long after the snapshot. Nothing checked it.
  it("denies a private destination reached through an owned child", async () => {
    const graph = new TaskGraph();
    graph.addTask(new OwningFetchTask({ id: "owner" } as never));

    await expect(run(graph)).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  });

  it("still runs the owned child when enforcement is off", async () => {
    const graph = new TaskGraph();
    graph.addTask(new OwningFetchTask({ id: "owner" } as never));

    await expect(run(graph, false)).resolves.toBeDefined();
    expect(fetched).toEqual([METADATA_URL]);
  });

  // A subgraph used to run with `enforceEntitlements` defaulted off, so nothing
  // inside one was ever checked at runtime.
  //
  // Isolating that from pre-flight takes care: pre-flight already recurses into
  // a subgraph through `GraphAsTask.entitlements()`, so a statically-declared
  // private URL nested in a group is caught with or without the fix. What only
  // the inner runtime check can catch is a URL that does not exist until the
  // subgraph runs. The policy below is built so pre-flight cannot object: the
  // inner Fetch has no url yet, so it declares the unscoped `network:private`,
  // which the broad grant covers and the resource-scoped deny — by
  // `grantCoversResources`, a scoped rule never covers a broad requirement —
  // cannot match. Only once the inner dataflow delivers the real URL does the
  // declaration narrow to the denied host.
  function denyMetadataRegistry(): ServiceRegistry {
    const enforcer = createPolicyEnforcer({
      deny: [{ id: Entitlements.NETWORK_PRIVATE, resources: ["http://169.254.169.254/*"] }],
      grant: [
        { id: Entitlements.NETWORK_HTTP },
        { id: Entitlements.CREDENTIAL },
        { id: Entitlements.NETWORK_PRIVATE },
      ],
      ask: [],
    });
    const registry = new ServiceRegistry(new Container());
    registry.register(ENTITLEMENT_ENFORCER, () => enforcer);
    return registry;
  }

  function graphWithInnerComputedUrl(url: string): TaskGraph {
    const inner = new TaskGraph();
    inner.addTask(
      new (class extends Task<Record<string, unknown>, Record<string, unknown>> {
        public static override type = "InnerUrlSource";
        public static override outputSchema(): DataPortSchema {
          return {
            type: "object",
            properties: { url: { type: "string", format: "uri", title: "URL" } },
            required: ["url"],
          } as DataPortSchema;
        }
        public override async execute() {
          return { url };
        }
      })({ id: "src" } as never)
    );
    inner.addTask(
      new FetchUrlTask({ id: "inner-fetch", defaults: { response_type: "text" } } as never)
    );
    inner.addDataflow(new Dataflow("src", "url", "inner-fetch", "url"));

    const group = new GraphAsTask({ id: "group" } as never);
    group.subGraph = inner;
    const graph = new TaskGraph();
    graph.addTask(group);
    return graph;
  }

  it("denies a private url that only exists once the subgraph is running", async () => {
    fetched = [];
    const graph = graphWithInnerComputedUrl(METADATA_URL);

    await expect(
      new TaskGraphRunner(graph).runGraph(
        {},
        { registry: denyMetadataRegistry(), enforceEntitlements: true }
      )
    ).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  });

  // A graph run stamps enforcement onto each task it schedules; a task run directly
  // was handed the option but never told its subgraph, which then ran unchecked.
  it("denies it as well when the group is run directly with enforcement on", async () => {
    fetched = [];
    const group = graphWithInnerComputedUrl(METADATA_URL).getTask("group")!;

    await expect(
      group.run({}, { registry: denyMetadataRegistry(), enforceEntitlements: true })
    ).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  });

  it("enforces only for the run that asked: a later run without it is not checked", async () => {
    fetched = [];
    const group = graphWithInnerComputedUrl(METADATA_URL).getTask("group")!;
    await expect(
      group.run({}, { registry: denyMetadataRegistry(), enforceEntitlements: true })
    ).rejects.toThrow(TaskEntitlementError);

    // No enforcer registered and enforcement off: the subgraph must not demand one.
    await expect(group.run({}, { enforceEntitlements: false })).resolves.toBeDefined();
    expect(fetched).toEqual([METADATA_URL]);
  });

  it("allows a public url produced inside the subgraph", async () => {
    fetched = [];
    const graph = graphWithInnerComputedUrl("https://example.com/data.json");

    await expect(
      new TaskGraphRunner(graph).runGraph(
        {},
        { registry: denyMetadataRegistry(), enforceEntitlements: true }
      )
    ).resolves.toBeDefined();
    expect(fetched).toEqual(["https://example.com/data.json"]);
  });

  // Pre-flight already covered this one; kept so the aggregate path stays wired.
  it("denies a statically declared private url nested in a subgraph", async () => {
    const inner = new TaskGraph();
    inner.addTask(
      new FetchUrlTask({
        id: "inner-fetch",
        defaults: { url: METADATA_URL, response_type: "text" },
      } as never)
    );
    const group = new GraphAsTask({ id: "group" } as never);
    group.subGraph = inner;
    const graph = new TaskGraph();
    graph.addTask(group);

    await expect(run(graph)).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  });
});

// Every compound task runs its subgraph its own way — a clone per item, the
// same graph per pass, each alternative on its own — and each of those runs is
// a separate place enforcement has to be handed on. The group above is one of
// them; these are the rest, with the same runtime-only url.
describe("entitlement enforcement reaches the subgraphs of loop and fallback tasks", () => {
  function urlSourceAndFetch(): TaskGraph {
    const inner = new TaskGraph();
    inner.addTask(
      new (class extends Task<Record<string, unknown>, Record<string, unknown>> {
        public static override type = "LoopInnerUrlSource";
        public static override inputSchema(): DataPortSchema {
          return { type: "object", properties: {}, additionalProperties: true } as DataPortSchema;
        }
        public static override outputSchema(): DataPortSchema {
          return {
            type: "object",
            properties: { url: { type: "string", format: "uri", title: "URL" } },
            required: ["url"],
          } as DataPortSchema;
        }
        public override async execute() {
          return { url: METADATA_URL };
        }
      })({ id: "src" } as never)
    );
    inner.addTask(
      new FetchUrlTask({ id: "inner-fetch", defaults: { response_type: "text" } } as never)
    );
    inner.addDataflow(new Dataflow("src", "url", "inner-fetch", "url"));
    return inner;
  }

  function denyMetadata(): ServiceRegistry {
    const registry = new ServiceRegistry(new Container());
    registry.register(ENTITLEMENT_ENFORCER, () =>
      createPolicyEnforcer({
        deny: [{ id: Entitlements.NETWORK_PRIVATE, resources: ["http://169.254.169.254/*"] }],
        grant: [
          { id: Entitlements.NETWORK_HTTP },
          { id: Entitlements.CREDENTIAL },
          { id: Entitlements.NETWORK_PRIVATE },
        ],
        ask: [],
      })
    );
    return registry;
  }

  async function expectDenied(task: ITask, input: Record<string, unknown>): Promise<void> {
    fetched = [];
    const graph = new TaskGraph();
    graph.addTask(task);
    await expect(
      new TaskGraphRunner(graph).runGraph(input, {
        registry: denyMetadata(),
        enforceEntitlements: true,
      })
    ).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  }

  it("MapTask: every item's clone is checked", async () => {
    const map = new MapTask({ id: "map", maxIterations: 5 } as never);
    map.subGraph = urlSourceAndFetch();
    await expectDenied(map, { items: [1, 2] });
  });

  it("ReduceTask: every step is checked", async () => {
    const reduce = new ReduceTask({ id: "reduce", maxIterations: 5 } as never);
    reduce.subGraph = urlSourceAndFetch();
    await expectDenied(reduce, { items: [1] });
  });

  it("WhileTask: every pass is checked", async () => {
    const loop = new WhileTask({ id: "while", maxIterations: 1, condition: () => false } as never);
    loop.subGraph = urlSourceAndFetch();
    await expectDenied(loop, {});
  });

  it("FallbackTask in data mode: every attempt is checked", async () => {
    const fallback = new FallbackTask({
      id: "fallback",
      fallbackMode: "data",
      alternatives: [{}],
    } as never);
    fallback.subGraph = urlSourceAndFetch();
    await expectDenied(fallback, {});
  });

  it("FallbackTask in task mode: every alternative is checked", async () => {
    // The url reaches the alternative from upstream, at run time, so pre-flight
    // sees only an unscoped `network:private` that the broad grant covers.
    const alternatives = new TaskGraph();
    alternatives.addTask(
      new FetchUrlTask({ id: "alt-fetch", defaults: { response_type: "text" } } as never)
    );
    const fallback = new FallbackTask({ id: "fallback", fallbackMode: "task" } as never);
    fallback.subGraph = alternatives;

    const graph = new TaskGraph();
    graph.addTask(
      new (class extends Task<Record<string, unknown>, Record<string, unknown>> {
        public static override type = "OuterUrlSource";
        public static override outputSchema(): DataPortSchema {
          return {
            type: "object",
            properties: { url: { type: "string", format: "uri", title: "URL" } },
            required: ["url"],
          } as DataPortSchema;
        }
        public override async execute() {
          return { url: METADATA_URL };
        }
      })({ id: "outer-src" } as never)
    );
    graph.addTask(fallback);
    graph.addDataflow(new Dataflow("outer-src", "url", "fallback", "url"));

    fetched = [];
    await expect(
      new TaskGraphRunner(graph).runGraph(
        {},
        { registry: denyMetadata(), enforceEntitlements: true }
      )
    ).rejects.toThrow(TaskEntitlementError);
    expect(fetched).toEqual([]);
  });
});

describe("entitlement declaration surfaces", () => {
  it("a task that owns a fetch child still declares nothing on its own", () => {
    // Documents why the runtime check is the backstop: the owner's static
    // declaration says nothing about the network its child will reach.
    const declared: TaskEntitlements = new OwningFetchTask({ id: "owner" } as never).entitlements();
    expect(declared.entitlements).toEqual([]);
  });
});
