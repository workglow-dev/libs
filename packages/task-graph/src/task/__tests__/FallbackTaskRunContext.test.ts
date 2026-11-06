/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, TaskInput } from "@workglow/task-graph";
import { FallbackTask, Task, TaskAbortedError, TaskGraph } from "@workglow/task-graph";
import { Container, createServiceToken, ResourceScope, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, test } from "vitest";

const GREETING = createServiceToken<string>("test.fallback.greeting");

const anyObject = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const satisfies DataPortSchema;

/** Records what the run handed it, then waits for its signal or answers at once. */
class ProbeTask extends Task<TaskInput, { seen: string }> {
  public static override type = "FallbackRunContext_ProbeTask";
  public static override inputSchema(): DataPortSchema {
    return anyObject;
  }
  public static override outputSchema(): DataPortSchema {
    return anyObject;
  }
  public hang = false;
  public started = false;
  public sawAbort = false;
  public registry: ServiceRegistry | undefined;
  public scope: ResourceScope | undefined;

  override async execute(_input: TaskInput, context: IExecuteContext): Promise<{ seen: string }> {
    this.started = true;
    this.registry = context.registry;
    this.scope = context.resourceScope;
    if (this.hang) {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) return resolve();
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.sawAbort = context.signal.aborted;
      throw new TaskAbortedError("probe aborted");
    }
    return {
      seen: context.registry.has(GREETING) ? context.registry.get(GREETING) : "global",
    };
  }
}

function fallbackOf(...alternatives: Task[]): FallbackTask {
  const task = new FallbackTask({ fallbackMode: "task" });
  const subGraph = new TaskGraph();
  for (const alternative of alternatives) subGraph.addTask(alternative);
  task.subGraph = subGraph;
  return task;
}

// In task mode an alternative is run directly, not through the subgraph runner, so
// nothing handed it the run's context: cancelling the fallback left the attempt in
// flight running, and it resolved services from the global registry.
describe("FallbackTask task mode runs its alternatives inside the run", () => {
  test("cancelling the fallback cancels the alternative in flight", async () => {
    const probe = new ProbeTask({ id: "hang" } as never);
    probe.hang = true;
    const fallback = fallbackOf(probe);
    const run = fallback.run({});
    while (!probe.started) await new Promise((r) => setTimeout(r, 1));
    fallback.abort();

    const settled = await Promise.race([
      run.then(
        () => "resolved",
        (err: unknown) => err
      ),
      new Promise((r) => setTimeout(() => r("still running"), 1000)),
    ]);
    expect(settled).toBeInstanceOf(TaskAbortedError);
    expect(probe.sawAbort).toBe(true);
  });

  test("an alternative resolves services from the run's registry", async () => {
    const registry = new ServiceRegistry(new Container());
    registry.registerInstance(GREETING, "from the run");
    const result = await fallbackOf(new ProbeTask({ id: "probe" } as never)).run({}, { registry });
    expect((result as { seen: string }).seen).toBe("from the run");
  });

  test("an alternative shares the run's resource scope", async () => {
    const scope = new ResourceScope();
    const probe = new ProbeTask({ id: "probe" } as never);
    await fallbackOf(probe).run({}, { resourceScope: scope });
    expect(probe.scope).toBe(scope);
  });
});
