/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Task } from "../Task";
import { TaskInvalidInputError } from "../TaskError";

function schemaOf(required: readonly string[]): DataPortSchema {
  return {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
    required: [...required],
    additionalProperties: false,
  } as DataPortSchema;
}

/** A class per test: compiled schemas are cached on the class, so sharing one leaks hits. */
function dynamicSchemaTaskClass() {
  return class DynamicSchemaTask extends Task<Record<string, unknown>, Record<string, unknown>> {
    public static override type = "DynamicSchemaTask";
    public static override hasDynamicSchemas = true;
    public schema: DataPortSchema = schemaOf([]);
    public override inputSchema(): DataPortSchema {
      return this.schema;
    }
  };
}

describe("validateInput with a dynamic input schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compiles an unchanged schema once, not on every validation", async () => {
    const DynamicSchemaTask = dynamicSchemaTaskClass();
    const task = new DynamicSchemaTask();
    // A second instance whose schema is equal in content shares the compiled node.
    const other = new DynamicSchemaTask();
    other.schema = schemaOf([]);
    const compile = vi.spyOn(DynamicSchemaTask as never, "generateInputSchemaNode");
    for (let i = 0; i < 5; i++) await task.validateInput({ a: "x" });
    await other.validateInput({ a: "y" });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("follows a schema edited in place", async () => {
    const DynamicSchemaTask = dynamicSchemaTaskClass();
    const task = new DynamicSchemaTask();
    await expect(task.validateInput({ a: "x" })).resolves.toBe(true);
    (task.schema as { required: string[] }).required.push("b");
    await expect(task.validateInput({ a: "x" })).rejects.toBeInstanceOf(TaskInvalidInputError);
    await expect(task.validateInput({ a: "x", b: 1 })).resolves.toBe(true);
  });

  it("follows a schema replaced between validations", async () => {
    const DynamicSchemaTask = dynamicSchemaTaskClass();
    const task = new DynamicSchemaTask();
    task.schema = schemaOf(["a"]);
    await expect(task.validateInput({ b: 1 })).rejects.toBeInstanceOf(TaskInvalidInputError);
    task.schema = schemaOf(["b"]);
    await expect(task.validateInput({ b: 1 })).resolves.toBe(true);
  });

  it("caches the stream-skipped schema too, and still skips the named ports", async () => {
    const DynamicSchemaTask = dynamicSchemaTaskClass();
    const task = new DynamicSchemaTask();
    task.schema = schemaOf(["a", "b"]);
    const compile = vi.spyOn(DynamicSchemaTask as never, "generateInputSchemaNode");
    const skip = new Set(["b"]);
    for (let i = 0; i < 3; i++) {
      await expect(task.validateInput({ a: "x" }, skip)).resolves.toBe(true);
    }
    await expect(task.validateInput({ b: 2 }, skip)).rejects.toBeInstanceOf(TaskInvalidInputError);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
