/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeGraphEntitlements,
  Dataflow,
  MapTask,
  Task,
  TaskGraph,
  withStaticInputProjection,
  type TaskEntitlements,
} from "@workglow/task-graph";
import { InputTask } from "@workglow/tasks";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";
import { FetchUrlTask } from "../../../../tasks/src/task/FetchUrlTask";

const PUBLIC_URL = "https://en.wikipedia.org/api/rest_v1/page/html/Workflow";
const PRIVATE_URL = "http://169.254.169.254/latest/meta-data/";

/**
 * A source whose output is only known by running — it declares no
 * `passthroughInputsToOutputs`, so the projection must not guess at it.
 */
class ComputedUrlTask extends Task<Record<string, unknown>, Record<string, unknown>> {
  public static override type = "ComputedUrlTask";
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string", format: "uri", title: "URL" } },
      required: ["url"],
    } as DataPortSchema;
  }
  public override async execute() {
    return { url: PRIVATE_URL };
  }
}

function urlPort(extra: Record<string, unknown> = {}) {
  return { type: "string", format: "uri", title: "URL", ...extra };
}

function graphWithSource(source: "input" | "computed", urlDefault?: string) {
  const graph = new TaskGraph();
  graph.addTask(
    source === "input"
      ? new InputTask({
          id: "src",
          inputSchema: {
            type: "object",
            properties: { url: urlPort(urlDefault ? { default: urlDefault } : {}) },
            required: ["url"],
          },
          outputSchema: { type: "object", properties: { url: urlPort() }, required: ["url"] },
        } as any)
      : new ComputedUrlTask({ id: "src" } as any)
  );
  graph.addTask(new FetchUrlTask({ id: "fetch", defaults: { response_type: "text" } } as any));
  graph.addDataflow(new Dataflow("src", "url", "fetch", "url"));
  return graph;
}

function privateEntitlement(e: TaskEntitlements) {
  return e.entitlements.find((x) => x.id === "network:private");
}

describe("withStaticInputProjection", () => {
  // Without the projection every dataflow-fed Fetch declares the fail-closed
  // superset, so a public URL is denied exactly as readily as a private one and
  // only an unscoped `network:private` grant can run the graph.
  it("drops network:private entirely for a statically-known public url", () => {
    const graph = graphWithSource("input", PUBLIC_URL);
    const required = withStaticInputProjection(graph, undefined, () =>
      computeGraphEntitlements(graph)
    );
    expect(privateEntitlement(required)).toBeUndefined();
  });

  it("scopes network:private to the host for a statically-known private url", () => {
    const graph = graphWithSource("input", PRIVATE_URL);
    const required = withStaticInputProjection(graph, undefined, () =>
      computeGraphEntitlements(graph)
    );
    expect(privateEntitlement(required)?.resources).toEqual(["http://169.254.169.254/*"]);
  });

  it("prefers the run input over the port's schema default", () => {
    const graph = graphWithSource("input", PUBLIC_URL);
    const required = withStaticInputProjection(graph, { url: PRIVATE_URL }, () =>
      computeGraphEntitlements(graph)
    );
    expect(privateEntitlement(required)?.resources).toEqual(["http://169.254.169.254/*"]);
  });

  // The safety property: a value that only exists after the source runs stays
  // unknown, so the downstream declaration remains the unscoped fail-closed one.
  it("leaves the fail-closed declaration when the source output is computed", () => {
    const graph = graphWithSource("computed");
    const required = withStaticInputProjection(graph, undefined, () =>
      computeGraphEntitlements(graph)
    );
    const declared = privateEntitlement(required);
    expect(declared).toBeDefined();
    expect(declared?.resources).toBeUndefined();
  });

  it("restores every task's input data, so nothing executes against a projected value", () => {
    const graph = graphWithSource("input", PUBLIC_URL);
    const fetch = graph.getTask("fetch")!;
    const before = fetch.runInputData;

    withStaticInputProjection(graph, { url: PRIVATE_URL }, () => {
      expect(fetch.runInputData["url"]).toBe(PRIVATE_URL);
      return undefined;
    });

    expect(fetch.runInputData).toBe(before);
    expect(fetch.runInputData["url"]).toBeUndefined();
  });

  // The Help/Blog Indexer is this shape: an outer url[] fans into a MapTask
  // whose subgraph FileLoader/Fetch classifies `url`. Projection seeds the
  // subgraph with the whole array; classifying it must scope private hosts,
  // not fail-close unscoped (which a loopback grant cannot cover).
  it("scopes network:private for a MapTask url array of private hosts", () => {
    const inner = new TaskGraph();
    inner.addTask(new FetchUrlTask({ id: "fetch", defaults: { response_type: "text" } } as any));
    const map = new MapTask({ id: "map", maxIterations: "unbounded" });
    map.subGraph = inner;
    const graph = new TaskGraph();
    graph.addTask(map);

    const required = withStaticInputProjection(
      graph,
      {
        url: [
          "http://localhost:5173/raw/workglow.dev/blog/a.mdx",
          "http://localhost:5173/raw/workglow.dev/blog/b.mdx",
        ],
      },
      () => computeGraphEntitlements(graph)
    );
    const declared = privateEntitlement(required);
    expect(declared).toBeDefined();
    expect(declared?.resources).toEqual(["http://localhost:5173/*"]);
  });
});
