/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskRegistry } from "@workglow/task-graph";
import type { IExecuteContext } from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import { describe, expect, it } from "vitest";
import { A2UI_BASIC_CATALOG, A2UI_BASIC_CATALOG_ID } from "../../catalog/basicCatalog";
import type { A2UIServerMessage } from "../../protocol/messages";
import type { A2UIPresentRequest, A2UIPresentResult, IA2UIConnector } from "../A2UIConnector";
import { A2UI_CONNECTOR } from "../A2UIConnector";
import type { A2UISurfaceTaskInput, A2UISurfaceTaskOutput } from "../A2UISurfaceTask";
import { A2UISurfaceTask } from "../A2UISurfaceTask";

class RecordingConnector implements IA2UIConnector {
  public seen: A2UIPresentRequest[] = [];
  constructor(
    private readonly status: A2UIPresentResult["status"],
    private readonly action?: A2UIPresentResult["action"]
  ) {}
  async present(request: A2UIPresentRequest): Promise<A2UIPresentResult> {
    this.seen.push(request);
    return { requestId: request.requestId, status: this.status, action: this.action };
  }
}

const ok: A2UIServerMessage[] = [
  { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "s1",
      components: [
        { id: "root", component: "Column", children: ["go"] },
        {
          id: "go",
          component: "Button",
          child: "label",
          action: { event: { name: "go", context: {} } },
        },
        { id: "label", component: "Text", text: "Go" },
      ],
    },
  },
];

function mkContext(connector: IA2UIConnector | undefined): IExecuteContext {
  const registry = new ServiceRegistry(new Container());
  if (connector) registry.registerInstance(A2UI_CONNECTOR, connector);
  return {
    signal: new AbortController().signal,
    updateProgress: async () => {},
    own: <T>(i: T) => i,
    registry,
  } as unknown as IExecuteContext;
}

function run(
  connector: IA2UIConnector | undefined,
  input: A2UISurfaceTaskInput
): Promise<A2UISurfaceTaskOutput> {
  return new A2UISurfaceTask().execute(input, mkContext(connector));
}

describe("A2UISurfaceTask", () => {
  it("declares a title, because the progress UI labels the row with it", () => {
    expect(A2UISurfaceTask.title).toBeTruthy();
  });

  // Vitest only: this compares the registered class against the one imported
  // relatively above, and the two are only the same object when both specifiers
  // resolve to the same module. Vitest rewrites `@workglow/*` to the package's
  // `src`, so they do. Bun resolves the entry through `exports` to `dist` while
  // the relative import stays on `src`, giving two structurally identical
  // classes that are not identical objects — the identity this asserts cannot
  // exist there. Registration itself is unaffected; only the comparison is.
  it.skipIf(typeof Bun !== "undefined")("is registered by importing the package entry, under its own type", async () => {
    await import("@workglow/a2ui/tasks");
    expect(TaskRegistry.all.get("A2UISurfaceTask")).toBe(A2UISurfaceTask);
  });

  it("presents a valid batch and reports the action", async () => {
    const connector = new RecordingConnector("action", {
      name: "go",
      surfaceId: "s1",
      sourceComponentId: "go",
      timestamp: "2026-09-15T00:00:00.000Z",
      context: { picked: 3 },
    });
    const output = await run(connector, { messages: ok });
    expect(output.status).toBe("action");
    expect(output.eventName).toBe("go");
    expect(output.sourceComponentId).toBe("go");
    expect(output.context).toEqual({ picked: 3 });
    expect(output.surfaceId).toBe("s1");
    expect(connector.seen[0]?.expectsAction).toBe(true);
    expect(connector.seen[0]?.catalogId).toBe(A2UI_BASIC_CATALOG_ID);
  });

  it("carries no action when the person walked away", async () => {
    const connector = new RecordingConnector("dismissed");
    const output = await run(connector, { messages: ok });
    expect(output.status).toBe("dismissed");
    expect(output.eventName).toBeUndefined();
  });

  it("tells the host when nothing is expected of the person", async () => {
    const connector = new RecordingConnector("presented");
    await run(connector, { messages: ok, expectsAction: false });
    expect(connector.seen[0]?.expectsAction).toBe(false);
  });

  it("refuses a malformed batch before any host is reached", async () => {
    const connector = new RecordingConnector("presented");
    await expect(
      run(connector, {
        messages: [{ version: "v0.9" } as unknown as A2UIServerMessage],
      })
    ).rejects.toThrow(/A2UI batch refused/);
    expect(connector.seen).toHaveLength(0);
  });

  it("refuses a component outside the catalog, naming it", async () => {
    const connector = new RecordingConnector("presented");
    await expect(
      run(connector, {
        messages: [
          { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
          {
            version: "v0.9",
            updateComponents: {
              surfaceId: "s1",
              components: [{ id: "root", component: "RawHtml", html: "<script>x</script>" }],
            },
          },
        ],
      })
    ).rejects.toThrow(/RawHtml/);
    expect(connector.seen).toHaveLength(0);
  });

  it("refuses rather than degrading the surface when no host can draw one", async () => {
    await expect(run(undefined, { messages: ok })).rejects.toThrow(/A2UI_CONNECTOR/);
  });
});

describe("configuration and batch shape", () => {
  it("accepts the catalog it documents as configurable", async () => {
    // `Task` validates config with `additionalProperties: false`, so without a
    // config schema naming it this threw during construction and the documented
    // per-run catalog could never be used.
    const narrowed = {
      ...A2UI_BASIC_CATALOG,
      components: A2UI_BASIC_CATALOG.components.filter((c) => c.name === "Text"),
    };
    const task = new A2UISurfaceTask({ catalog: narrowed });
    const connector = new RecordingConnector("presented");
    await expect(
      task.execute({ messages: ok, expectsAction: false }, mkContext(connector))
    ).rejects.toThrow(/Column|Button/);
  });

  it("refuses a batch creating more than one surface", async () => {
    // The output models one surface, so a two-surface batch would report an
    // action without saying which surface produced it.
    const connector = new RecordingConnector("presented");
    await expect(
      run(connector, {
        messages: [
          ...ok,
          { version: "v0.9", createSurface: { surfaceId: "s2", catalogId: A2UI_BASIC_CATALOG_ID } },
          {
            version: "v0.9",
            updateComponents: {
              surfaceId: "s2",
              components: [{ id: "root", component: "Text", text: "second" }],
            },
          },
        ],
      })
    ).rejects.toThrow(/creates 2 surfaces/);
    expect(connector.seen).toHaveLength(0);
  });
});
