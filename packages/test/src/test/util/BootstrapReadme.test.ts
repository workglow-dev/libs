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
 *
 * Two halves are pinned below. The first `describe` exercises both shapes at
 * runtime, proving the documented one works and the old one does not. The
 * second reads the two documents themselves, so a snippet that rots back is a
 * test failure rather than prose nobody re-checks. The document cases scan
 * every fenced block for the wrong shape, so a deliberate counter-example in
 * the README would trip them — write the counter-example as prose instead.
 */

import { createOrchestrationContext } from "@workglow/bootstrap";
import type { IExecuteContext, TaskInput, TaskOutput } from "@workglow/task-graph";
import { Task } from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { globalServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const README_PATH = join(REPO_ROOT, "packages/bootstrap/README.md");
const SOURCE_PATH = join(REPO_ROOT, "packages/bootstrap/src/bootstrap/bootstrapWorkglow.ts");

/** The registry travelling in the run config — `run()`'s second argument. */
const REGISTRY_IN_RUN_CONFIG =
  /\.run\(\s*\{\s*\}\s*,\s*\{\s*registry:\s*\w+\.registry[\s,]*\}\s*\)/;
/** The shape that silently becomes an input override named `context`. */
const CONTEXT_AS_INPUT = /\.run\(\s*\{\s*context\s*:/;

/**
 * Every fenced code block's body, whatever its info string. Selecting blocks by
 * content rather than by the heading above them keeps a heading rename from
 * making these cases pass vacuously.
 */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]!);
}

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

describe("the documents the example is transcribed from", () => {
  it("README documents the registry in the run config", () => {
    const blocks = fencedBlocks(readFileSync(README_PATH, "utf8")).filter((block) =>
      block.includes("createOrchestrationContext(")
    );

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => REGISTRY_IN_RUN_CONFIG.test(block))).toBe(true);
  });

  it("no README code block passes the context as an input override", () => {
    // Code only: the surrounding prose deliberately discusses "an input named
    // `context`" and has to stay legal.
    const offenders = fencedBlocks(readFileSync(README_PATH, "utf8")).filter((block) =>
      CONTEXT_AS_INPUT.test(block)
    );

    expect(offenders).toEqual([]);
  });

  it("the createOrchestrationContext JSDoc shows the same shape", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const jsdoc = source.match(
      /\/\*\*([\s\S]*?)\*\/\s*export function createOrchestrationContext\b/
    );

    expect(jsdoc).not.toBeNull();

    const comment = jsdoc![1]!.replace(/^\s*\*/gm, "");
    expect(REGISTRY_IN_RUN_CONFIG.test(comment)).toBe(true);
    expect(CONTEXT_AS_INPUT.test(comment)).toBe(false);
  });
});
