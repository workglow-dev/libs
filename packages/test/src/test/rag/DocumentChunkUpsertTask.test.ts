/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChunkVectorUpsertTask } from "@workglow/ai";
import { TaskInvalidInputError } from "@workglow/task-graph";
import type { ChunkRecord, KnowledgeBase } from "@workglow/knowledge-base";
import { createKnowledgeBase, registerKnowledgeBase } from "@workglow/knowledge-base";
import { setLogger, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { report, snap } from "../../binding/testTiming";

const makeChunk = (overrides: Partial<ChunkRecord> & { doc_id?: string }): ChunkRecord => ({
  chunkId: uuid4(),
  doc_id: overrides.doc_id ?? "doc1",
  text: "Test content",
  nodePath: ["root"],
  depth: 0,
  ...overrides,
});

describe("ChunkVectorUpsertTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  let kb: KnowledgeBase;

  beforeEach(async () => {
    kb = await createKnowledgeBase({
      name: `upsert-test-${uuid4()}`,
      vectorDimensions: 3,
      register: false,
    });
  });

  afterEach(() => {
    kb.destroy();
  });

  test("should upsert a single chunk + vector", async () => {
    const s = snap();
    const chunk = makeChunk({ text: "Test document", doc_id: "doc1" });
    const vector = new Float32Array([0.1, 0.2, 0.3]);

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: kb,
      chunks: [chunk],
      vector: [vector],
    });

    expect(result.count).toBe(1);
    expect(result.doc_id).toBe("doc1");
    expect(result.chunk_ids).toHaveLength(1);

    const retrieved = await kb.getChunk(result.chunk_ids[0]);
    expect(retrieved).toBeDefined();
    expect(retrieved?.doc_id).toBe("doc1");
    expect(retrieved!.metadata).toMatchObject({ text: "Test document" });
    report("chunk-upsert: single", s);
  });

  test("should accept a single vector (not wrapped in an array)", async () => {
    const s = snap();
    const chunk = makeChunk({ text: "Shortcut single-vector form", doc_id: "doc1" });
    const vector = new Float32Array([0.1, 0.2, 0.3]);

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: kb,
      chunks: [chunk],
      vector,
    });

    expect(result.count).toBe(1);
    expect(result.doc_id).toBe("doc1");
    report("chunk-upsert: single-vector", s);
  });

  test("should upsert multiple chunks + vectors in bulk", async () => {
    const s = snap();
    const chunks = [
      makeChunk({ text: "Part 1", doc_id: "doc1" }),
      makeChunk({ text: "Part 2", doc_id: "doc1" }),
      makeChunk({ text: "Part 3", doc_id: "doc1" }),
    ];
    const vectors = [
      new Float32Array([0.1, 0.2, 0.3]),
      new Float32Array([0.4, 0.5, 0.6]),
      new Float32Array([0.7, 0.8, 0.9]),
    ];

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: kb,
      chunks,
      vector: vectors,
    });

    expect(result.count).toBe(3);
    expect(result.doc_id).toBe("doc1");
    expect(result.chunk_ids).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const retrieved = await kb.getChunk(result.chunk_ids[i]);
      expect(retrieved).toBeDefined();
      expect(retrieved?.doc_id).toBe("doc1");
    }
    report("chunk-upsert: bulk", s);
  });

  test("should derive leafNodeId from nodePath when not set explicitly", async () => {
    const s = snap();
    const chunk = makeChunk({
      text: "Derived leaf",
      nodePath: ["root", "section", "leaf-123"],
      depth: 2,
    });
    const vector = new Float32Array([0.1, 0.2, 0.3]);

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({ knowledgeBase: kb, chunks: [chunk], vector: [vector] });

    const retrieved = await kb.getChunk(result.chunk_ids[0]);
    expect(retrieved?.metadata).toMatchObject({ leafNodeId: "leaf-123" });
    report("chunk-upsert: leaf-node-id", s);
  });

  test("should stamp doc_title onto every chunk when provided", async () => {
    const s = snap();
    const chunks = [
      makeChunk({ text: "A", doc_id: "doc1" }),
      makeChunk({ text: "B", doc_id: "doc1" }),
    ];
    const vectors = [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])];

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: kb,
      chunks,
      vector: vectors,
      doc_title: "My Document",
    });

    const retrieved0 = await kb.getChunk(result.chunk_ids[0]);
    const retrieved1 = await kb.getChunk(result.chunk_ids[1]);
    expect(retrieved0?.metadata).toMatchObject({ doc_title: "My Document" });
    expect(retrieved1?.metadata).toMatchObject({ doc_title: "My Document" });
    report("chunk-upsert: doc-title", s);
  });

  test("should throw when chunks and vectors length mismatch", async () => {
    const s = snap();
    const chunks = [makeChunk({}), makeChunk({})];
    const vectors = [new Float32Array([0.1, 0.2, 0.3])];

    const task = new ChunkVectorUpsertTask();
    await expect(task.run({ knowledgeBase: kb, chunks, vector: vectors })).rejects.toThrow(
      "Mismatch"
    );
    await expect(
      new ChunkVectorUpsertTask().run({ knowledgeBase: kb, chunks, vector: vectors })
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    report("chunk-upsert: mismatch-throw", s);
  });

  test("should throw when chunks have mixed doc_ids", async () => {
    const s = snap();
    const chunks = [makeChunk({ doc_id: "doc-a" }), makeChunk({ doc_id: "doc-b" })];
    const vectors = [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])];

    const task = new ChunkVectorUpsertTask();
    await expect(task.run({ knowledgeBase: kb, chunks, vector: vectors })).rejects.toThrow(
      /share one doc_id/
    );
    await expect(
      new ChunkVectorUpsertTask().run({ knowledgeBase: kb, chunks, vector: vectors })
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    report("chunk-upsert: mixed-doc-ids", s);
  });

  test("should handle large batch upsert", async () => {
    const s = snap();
    const count = 100;
    const chunks = Array.from({ length: count }, (_, i) =>
      makeChunk({ text: `Part ${i}`, doc_id: "batch-doc" })
    );
    const vectors = Array.from(
      { length: count },
      (_, i) => new Float32Array([i * 0.01, i * 0.02, i * 0.03])
    );

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: kb,
      chunks,
      vector: vectors,
    });

    expect(result.count).toBe(count);
    expect(result.chunk_ids).toHaveLength(count);
    expect(await kb.chunkCount()).toBe(count);
    report("chunk-upsert: large-batch", s);
  });

  test("should resolve knowledge base from string ID", async () => {
    const s = snap();
    await registerKnowledgeBase("test-upsert-kb", kb);

    const chunk = makeChunk({ text: "Test document", doc_id: "doc1" });
    const vector = new Float32Array([0.1, 0.2, 0.3]);

    const task = new ChunkVectorUpsertTask();
    const result = await task.run({
      knowledgeBase: "test-upsert-kb",
      chunks: [chunk],
      vector: [vector],
    });

    expect(result.count).toBe(1);
    expect(result.doc_id).toBe("doc1");
    report("chunk-upsert: string-id", s);
  });
});
