/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScopedVectorStorage } from "@workglow/knowledge-base";
import type { AnyVectorStorage } from "@workglow/storage";
import { InMemoryVectorStorage } from "@workglow/storage";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { TypedArraySchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import { EAST, NORTH, VECTOR_DIMENSIONS } from "@workglow/test-contract/vector-storage";

/**
 * The inner schema, which carries the `kb_id` this class injects on write and
 * strips on read. It must be in the inner primary key — the class refuses an
 * inner store whose key omits it, because the injection would then not
 * distinguish two knowledge bases' rows.
 */
const ScopedInnerSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kb_id: { type: "string" },
    vector: TypedArraySchema(),
    metadata: { type: "object", format: "metadata", additionalProperties: true },
  },
  required: ["id", "kb_id", "vector", "metadata"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

const ScopedInnerPrimaryKey = ["kb_id", "id"] as const;

function scopedStore(kbId: string): AnyVectorStorage {
  const inner = new InMemoryVectorStorage(
    ScopedInnerSchema,
    ScopedInnerPrimaryKey,
    [],
    VECTOR_DIMENSIONS
  ) as unknown as AnyVectorStorage;
  return new ScopedVectorStorage(inner, kbId) as unknown as AnyVectorStorage;
}

/**
 * The wrapper the whole RAG path runs through, against the shared contract.
 *
 * It had no vector test of its own — what coverage it has comes incidentally
 * through the RAG suites, which are about what a knowledge base does rather
 * than about what a vector store owes its caller. The contract's outer surface
 * is exactly this class's: `kb_id` is injected on write and stripped on read,
 * so a caller sees the same rows it put in.
 */
runVectorStorageContract({
  name: "ScopedVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> => scopedStore("kb-under-test"),
});

/**
 * And the one thing the contract cannot ask, because it is what this class adds
 * rather than what the interface promises: two scopes over one inner store do
 * not see each other's rows.
 */
describe("ScopedVectorStorage scoping", () => {
  it("keeps two knowledge bases' rows apart in one inner store", async () => {
    const inner = new InMemoryVectorStorage(
      ScopedInnerSchema,
      ScopedInnerPrimaryKey,
      [],
      VECTOR_DIMENSIONS
    ) as unknown as AnyVectorStorage;
    const a = new ScopedVectorStorage(inner, "kb-a") as unknown as AnyVectorStorage;
    const b = new ScopedVectorStorage(inner, "kb-b") as unknown as AnyVectorStorage;

    // The same id in both scopes, which is the case the inner primary key has
    // to include `kb_id` for: one row would otherwise overwrite the other.
    await a.put({ id: "shared", vector: EAST, metadata: { owner: "a" } });
    await b.put({ id: "shared", vector: NORTH, metadata: { owner: "b" } });

    const fromA = (await a.similaritySearch(EAST)) as { id: string; metadata: unknown }[];
    const fromB = (await b.similaritySearch(EAST)) as { id: string; metadata: unknown }[];

    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.metadata).toEqual({ owner: "a" });
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.metadata).toEqual({ owner: "b" });
  });
});
