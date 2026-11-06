/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Dataflow, Task, TaskGraph } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

const PORTS = {
  plain: { type: "array", items: { type: "number" } },
  nullable: { type: ["array", "null"], items: { type: "number" } },
  anyOf: { anyOf: [{ type: "array", items: { type: "number" } }, { type: "null" }] },
  oneOrMany: { oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] },
} as const;

class SinkTask extends Task<Record<string, unknown>, Record<string, unknown>> {
  public static override type = "FanIn_Sink";
  public static override cacheable = false;
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: PORTS } as unknown as DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: true } as const;
  }
  public override async execute(input: Record<string, unknown>) {
    return { ...input };
  }
}

const SOURCE_VALUES: Record<string, unknown> = { a: [1], b: [2] };

class SourceTask extends Task<Record<string, never>, { v: unknown }> {
  public static override type = "FanIn_Source";
  public static override cacheable = false;
  public static override outputSchema(): DataPortSchema {
    return { type: "object", properties: { v: {} } } as const;
  }
  public override async execute() {
    return { v: SOURCE_VALUES[String(this.id)] };
  }
}

function deliver(port: keyof typeof PORTS, ...values: unknown[]): unknown {
  const task = new SinkTask();
  task.resetInputData();
  for (const value of values) task.addInput({ [port]: value });
  return task.runInputData[port];
}

// The graph runner hands each incoming dataflow to addInput in turn. A port that
// admits an array collects them; it used to only when its type was exactly "array".
describe("fan-in on a port that admits an array", () => {
  it.each(["plain", "nullable", "anyOf", "oneOrMany"] as const)(
    "%s collects two deliveries",
    (port) => {
      expect(deliver(port, [1], [2])).toEqual([1, 2]);
    }
  );

  it.each(["nullable", "anyOf", "oneOrMany"] as const)(
    "%s keeps a single delivery as it came",
    (port) => {
      expect(deliver(port, 5)).toBe(5);
      expect(deliver(port, [5])).toEqual([5]);
      expect(deliver(port, null)).toBeNull();
    }
  );

  it("a delivery replaces the port's default rather than joining it", () => {
    const task = new SinkTask({ defaults: { oneOrMany: 9 } } as never);
    task.resetInputData();
    task.addInput({ oneOrMany: 5 });
    expect(task.runInputData.oneOrMany).toBe(5);
  });

  it("two dataflows into a nullable array port arrive as one list", async () => {
    const graph = new TaskGraph();
    graph.addTasks([
      new SourceTask({ id: "a" }),
      new SourceTask({ id: "b" }),
      new SinkTask({ id: "sink" }),
    ]);
    graph.addDataflow(new Dataflow("a", "v", "sink", "nullable"));
    graph.addDataflow(new Dataflow("b", "v", "sink", "nullable"));
    await graph.run();
    expect(graph.getTask("sink")!.runOutputData.nullable).toEqual([1, 2]);
  });
});
