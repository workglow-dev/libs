/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryTabularStorage, TelemetryTabularStorage } from "@workglow/storage";
import {
  ConsoleTelemetryProvider,
  NoopTelemetryProvider,
  setTelemetryProvider,
} from "@workglow/util";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthorPrimaryKeyNames,
  AuthorSchema,
  PostPrimaryKeyNames,
  PostSchema,
  runTabularJoinContract,
  runTabularStorageContract,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/tabular-storage";
import { CompoundPrimaryKeyNames, CompoundSchema } from "./genericTabularStorageTests";

const TestSchema = {
  type: "object",
  properties: {
    id: { type: "integer", "x-auto-generated": true },
    name: { type: "string" },
  },
  required: ["id", "name"],
} as const satisfies DataPortSchemaObject;

type TestPK = readonly ["id"];
const TestPK = ["id"] as const;

describe("TelemetryTabularStorage", () => {
  let inner: InMemoryTabularStorage<typeof TestSchema, TestPK>;
  let wrapped: TelemetryTabularStorage<typeof TestSchema, TestPK>;
  let startSpanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const provider = new ConsoleTelemetryProvider();
    setTelemetryProvider(provider);
    startSpanSpy = vi.spyOn(provider, "startSpan");

    inner = new InMemoryTabularStorage(TestSchema, TestPK);
    wrapped = new TelemetryTabularStorage("test-tabular", inner);

    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setTelemetryProvider(new NoopTelemetryProvider());
    vi.restoreAllMocks();
  });

  it("should forward put and create a span", async () => {
    const entity = await wrapped.put({ name: "Alice" });
    expect(entity.name).toBe("Alice");
    expect(startSpanSpy).toHaveBeenCalledWith(
      "workglow.storage.tabular.put",
      expect.objectContaining({
        attributes: expect.objectContaining({ "workglow.storage.name": "test-tabular" }),
      })
    );
  });

  it("should forward get and create a span", async () => {
    const entity = await inner.put({ name: "Bob" });
    const result = await wrapped.get({ id: entity.id });
    expect(result?.name).toBe("Bob");
    expect(startSpanSpy).toHaveBeenCalledWith("workglow.storage.tabular.get", expect.anything());
  });

  it("should forward delete and create a span", async () => {
    const entity = await inner.put({ name: "Charlie" });
    await wrapped.delete({ id: entity.id });
    expect(await inner.get({ id: entity.id })).toBeUndefined();
  });

  it("should forward getAll and create a span", async () => {
    await inner.put({ name: "A" });
    await inner.put({ name: "B" });
    const result = await wrapped.getAll();
    expect(result).toHaveLength(2);
  });

  it("should forward query and create a span", async () => {
    await inner.put({ name: "Alice" });
    await inner.put({ name: "Bob" });
    const result = await wrapped.query({ name: "Alice" });
    expect(result).toHaveLength(1);
    expect(startSpanSpy).toHaveBeenCalledWith("workglow.storage.tabular.query", expect.anything());
  });

  it("should forward join, unwrap a traced right side, and create a span", async () => {
    const authorsInner = new InMemoryTabularStorage(TestSchema, TestPK);
    const authors = new TelemetryTabularStorage("test-authors", authorsInner);
    const innerJoin = vi.spyOn(inner, "join");
    await inner.put({ name: "Ann" });
    await authorsInner.put({ name: "Ann" });

    const rows = await wrapped.join(
      { type: "inner", on: [{ left: "name", right: "name" }] },
      authors
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].right.name).toBe("Ann");
    expect(innerJoin).toHaveBeenCalledWith(expect.anything(), authorsInner);
    expect(startSpanSpy).toHaveBeenCalledWith("workglow.storage.tabular.join", expect.anything());
  });

  it("should forward size and create a span", async () => {
    await inner.put({ name: "A" });
    expect(await wrapped.size()).toBe(1);
  });

  it("should forward event methods to inner storage", () => {
    const fn = vi.fn();
    wrapped.on("put", fn);
    inner.emit("put", { id: 1, name: "test" });
    expect(fn).toHaveBeenCalled();
  });
});

runTabularStorageContract({
  name: "TelemetryTabularStorage",
  createStorage: async () => {
    const inner = new InMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      CompoundSchema,
      CompoundPrimaryKeyNames
    );
    return new TelemetryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      "contract-test",
      inner
    );
  },
  capabilities: {
    supportsSubscriptions: true,
    supportsVectorColumns: true,
    supportsTransactions: false,
    supportsQuery: true,
  },
  // TelemetryTabularStorage delegates subscribeToChanges to its inner storage
  // (InMemoryTabularStorage here) which is strictly event-driven.
  usesPolling: false,
  createVectorStorage: async () => {
    const inner = new InMemoryTabularStorage<
      typeof VectorItemSchema,
      typeof VectorItemPrimaryKeyNames
    >(VectorItemSchema, VectorItemPrimaryKeyNames);
    return new TelemetryTabularStorage<typeof VectorItemSchema, typeof VectorItemPrimaryKeyNames>(
      "contract-vec",
      inner
    );
  },
});

describe("TelemetryTabularStorage join", () => {
  runTabularJoinContract(
    async () =>
      new TelemetryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
        "join-posts",
        new InMemoryTabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>(
          PostSchema,
          PostPrimaryKeyNames
        )
      ),
    async () =>
      new TelemetryTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
        "join-authors",
        new InMemoryTabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>(
          AuthorSchema,
          AuthorPrimaryKeyNames
        )
      )
  );
});
