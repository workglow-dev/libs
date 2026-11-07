/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GraphAsTask, Task, TaskConfigSchema, TaskConfigurationError } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

/** A port whose schema cannot be compiled: reading its `pattern` throws. */
function uncompilable(): Record<string, unknown> {
  const port: Record<string, unknown> = { type: "string" };
  Object.defineProperty(port, "pattern", {
    enumerable: true,
    get() {
      throw new Error("schema compiler choked");
    },
  });
  return port;
}

class BrokenInputTask extends Task<{ a?: string }, { ran: boolean }> {
  public static override type = "SchemaCompile_BrokenInput";
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: { a: uncompilable() } } as DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return { type: "object", properties: { ran: { type: "boolean" } } } as const;
  }
  public ran = false;
  public override async execute() {
    this.ran = true;
    return { ran: true };
  }
}

class BrokenConfigTask extends Task<Record<string, never>, Record<string, never>> {
  public static override type = "SchemaCompile_BrokenConfig";
  public static override configSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { ...TaskConfigSchema["properties"], mode: uncompilable() },
    } as DataPortSchema;
  }
}

class BrokenGraphTask extends GraphAsTask {
  public static override type = "SchemaCompile_BrokenGraph";
  public override inputSchema(): DataPortSchema {
    return { type: "object", properties: { a: uncompilable() } } as DataPortSchema;
  }
}

// A schema that will not compile used to be handled three ways: the input schema's
// fallback never ran (the compile sat outside its try), the config schema skipped
// validation with a warning, and GraphAsTask validated nothing. A task whose schema
// cannot be compiled does not run unvalidated.
describe("a schema that will not compile fails closed", () => {
  it("input schema: refuses the run, naming the class, and never executes", async () => {
    const task = new BrokenInputTask();
    const err = await task.run({ a: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskConfigurationError);
    expect(String((err as Error).message)).toMatch(/SchemaCompile_BrokenInput.*input schema/);
    expect(task.ran).toBe(false);
  });

  it("config schema: refuses at construction, naming the class", () => {
    expect(() => new BrokenConfigTask()).toThrow(TaskConfigurationError);
    expect(() => new BrokenConfigTask()).toThrow(/SchemaCompile_BrokenConfig.*config schema/);
  });

  it("GraphAsTask: refuses rather than validating nothing", async () => {
    const err = await new BrokenGraphTask().run({ a: "x" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskConfigurationError);
    expect(String((err as Error).message)).toMatch(/SchemaCompile_BrokenGraph.*input schema/);
  });
});
