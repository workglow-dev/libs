/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Executable transcription of the "Isolated context" example in
 * `packages/bootstrap/README.md` (and the matching `createOrchestrationContext`
 * JSDoc example).
 *
 * The README used to show `await task.run({ context: ctx })`. `Task.run` takes
 * input overrides first and a run config second, and neither `IRunConfig` nor
 * `TaskGraphRunConfig` has a `context` key — so with a loosely typed `Input`
 * that object is an input override named `context`, the run keeps the global
 * registry, and `ctx.dispose()` tears down a registry the task never touched.
 * Both halves are pinned below so the snippet cannot silently rot back.
 */

import { createOrchestrationContext } from "@workglow/bootstrap";
import type { IExecuteContext, TaskInput, TaskOutput } from "@workglow/task-graph";
import { Task } from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { globalServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

interface RegistryProbeOutput extends TaskOutput {
  isGlobal: boolean;
}

/** Reports whether the run resolved against the process-wide registry. */
class RegistryProbeTask extends Task<TaskInput, RegistryProbeOutput> {
  public static override readonly type = "RegistryProbeTask";
  public static override readonly category = "Test";
  public static override readonly title = "Registry probe";
  public static override readonly description = "Reports which service registry the run used.";
  public static override readonly cacheable = false;

  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { isGlobal: { type: "boolean" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public seenRegistry: ServiceRegistry | undefined;

  public override async execute(
    _input: TaskInput,
    context: IExecuteContext
  ): Promise<RegistryProbeOutput> {
    this.seenRegistry = context.registry;
    return { isGlobal: context.registry === globalServiceRegistry };
  }
}

describe("the @workglow/bootstrap README isolated-context example", () => {
  it("routes the run to the isolated registry when the context is passed in the run config", async () => {
    const ctx = createOrchestrationContext();
    const task = new RegistryProbeTask();
    try {
      const output = await task.run({}, { registry: ctx.registry });

      expect(output.isGlobal).toBe(false);
      expect(task.seenRegistry).toBe(ctx.registry);
    } finally {
      await ctx.dispose();
    }
  });

  it("keeps the global registry when a context is passed as an input override instead", async () => {
    const ctx = createOrchestrationContext();
    const task = new RegistryProbeTask();
    try {
      // The shape the README used to document. It type-checks only because this
      // task's input schema is open; the run silently ignores it.
      const output = await task.run({ context: ctx });

      expect(output.isGlobal).toBe(true);
      expect(task.seenRegistry).not.toBe(ctx.registry);
    } finally {
      await ctx.dispose();
    }
  });
});
