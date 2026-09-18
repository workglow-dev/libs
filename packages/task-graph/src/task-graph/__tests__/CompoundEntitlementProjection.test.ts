/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Dataflow,
  Entitlements,
  GraphAsTask,
  Task,
  TaskGraph,
  type TaskEntitlements,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

/**
 * Stands in for `FileLoaderTask`: what it reaches depends on the `url` it is
 * handed, so with no `url` it has to declare the fail-closed superset.
 */
class UrlReachTask extends Task {
  static override readonly type = "UrlReachTask";
  static override readonly category = "Test";
  static override hasDynamicEntitlements = true;

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  override entitlements(): TaskEntitlements {
    const url = this.runInputData?.url;
    if (typeof url !== "string" || url.length === 0) {
      // Fail closed: unscoped, because the destination is unknown.
      return { entitlements: [{ id: Entitlements.NETWORK_PRIVATE, reason: "url unknown" }] };
    }
    return {
      entitlements: [
        { id: Entitlements.NETWORK_PRIVATE, reason: "url known", resources: [`${url}/*`] },
      ],
    };
  }

  override async execute(): Promise<{ text: string }> {
    return { text: "" };
  }
}

/** Root of the subgraph, standing in for the `InputTask` a stored graph starts with. */
class PassthroughRootTask extends Task {
  static override readonly type = "PassthroughRootTask";
  static override readonly category = "Test";
  static override passthroughInputsToOutputs = true;

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  override async execute(input: { url: string }): Promise<{ url: string }> {
    return input;
  }
}

function buildCompound(): GraphAsTask {
  const subGraph = new TaskGraph();
  subGraph.addTask(new PassthroughRootTask({ id: "root" }));
  subGraph.addTask(new UrlReachTask({ id: "reach" }));
  subGraph.addDataflow(new Dataflow("root", "url", "reach", "url"));
  return new GraphAsTask({ id: "compound", subGraph });
}

describe("GraphAsTask.entitlements() input projection", () => {
  it("declares the fail-closed superset while its own input is unknown", () => {
    const compound = buildCompound();

    const declared = compound.entitlements().entitlements;

    expect(declared).toHaveLength(1);
    expect(declared[0].id).toBe(Entitlements.NETWORK_PRIVATE);
    expect(declared[0].resources).toBeUndefined();
  });

  it("scopes the declaration once its own input is known", () => {
    // What `TaskGraphRunner.runTask` leaves on a compound task before the
    // runtime `hasDynamicEntitlements` check: its input has been copied in
    // from its edges, but nothing has projected it into the subgraph. Without
    // that projection the subgraph still declares the fail-closed superset,
    // which no scoped grant can satisfy — so the task denies itself exactly
    // when its destination finally became known.
    const compound = buildCompound();
    compound.runInputData = { url: "https://example.com" };

    const declared = compound.entitlements().entitlements;

    expect(declared).toHaveLength(1);
    expect(declared[0].id).toBe(Entitlements.NETWORK_PRIVATE);
    expect(declared[0].resources).toEqual(["https://example.com/*"]);
  });

  it("leaves the subgraph exactly as it found it", () => {
    const compound = buildCompound();
    compound.runInputData = { url: "https://example.com" };

    compound.entitlements();

    for (const task of compound.subGraph.getTasks()) {
      expect(task.runInputData).toEqual({});
    }
  });
});
