/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChunkingStrategy, textChunker } from "@workglow/ai";
import { TaskInvalidInputError } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

import { report, snap } from "../../binding/testTiming";

describe("TextChunkerTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  const testText =
    "This is the first sentence. This is the second sentence! This is the third sentence? " +
    "This is the fourth sentence. This is the fifth sentence.";

  test("should chunk text with FIXED strategy and emit ChunkRecord[]", async () => {
    const s = snap();
    const result = await textChunker({
      text: testText,
      doc_id: "my-doc",
      chunkSize: 50,
      chunkOverlap: 10,
      strategy: ChunkingStrategy.FIXED,
    });

    expect(result.chunks).toBeDefined();
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.count).toBe(result.chunks.length);
    expect(result.text).toHaveLength(result.chunks.length);
    expect(result.doc_id).toBe("my-doc");

    result.chunks.forEach((chunk, idx) => {
      expect(chunk.chunkId).toBe(`my-doc:${idx}`);
      expect(chunk.doc_id).toBe("my-doc");
      expect(chunk.text).toBe(result.text[idx]);
      expect(chunk.nodePath).toEqual(["my-doc"]);
      expect(chunk.depth).toBe(chunk.nodePath.length);
    });
    report("text-chunk: fixed", s);
  });

  test("should omit doc_id from output when not provided and emit deterministic chunkIds", async () => {
    const s = snap();
    const first = await textChunker({ text: testText, chunkSize: 50 });
    const second = await textChunker({ text: testText, chunkSize: 50 });

    expect(first.doc_id).toBeUndefined();
    expect(second.doc_id).toBeUndefined();
    expect(first.chunks.map((c) => c.chunkId)).toEqual(second.chunks.map((c) => c.chunkId));
    first.chunks.forEach((chunk) => {
      expect(chunk.doc_id).toBe("");
      expect(chunk.nodePath).toEqual([]);
      expect(chunk.depth).toBe(0);
      expect(chunk.chunkId).toMatch(/^chunk:\d+:\d+$/);
    });
    report("text-chunk: no-doc-id", s);
  });

  test("should chunk with SENTENCE strategy", async () => {
    const s = snap();
    const result = await textChunker({
      text: testText,
      doc_id: "d1",
      chunkSize: 80,
      chunkOverlap: 20,
      strategy: ChunkingStrategy.SENTENCE,
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    result.chunks.forEach((chunk) => {
      expect(chunk.text.length).toBeGreaterThan(0);
    });
    report("text-chunk: sentence", s);
  });

  test("should chunk with PARAGRAPH strategy", async () => {
    const s = snap();
    const paragraphText =
      "First paragraph with multiple sentences. It has more content.\n\n" +
      "Second paragraph with different content. It also has sentences.\n\n" +
      "Third paragraph is here. With more text.";

    const result = await textChunker({
      text: paragraphText,
      doc_id: "d1",
      chunkSize: 100,
      chunkOverlap: 20,
      strategy: ChunkingStrategy.PARAGRAPH,
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    report("text-chunk: paragraph", s);
  });

  test("should honour a provided doc_id", async () => {
    const s = snap();
    const result = await textChunker({
      text: testText,
      doc_id: "my-doc",
      chunkSize: 50,
    });

    expect(result.doc_id).toBe("my-doc");
    result.chunks.forEach((chunk) => {
      expect(chunk.doc_id).toBe("my-doc");
    });
    report("text-chunk: doc-id", s);
  });

  test("should handle default parameters", async () => {
    const s = snap();
    const result = await textChunker({ text: testText });
    expect(result.chunks.length).toBeGreaterThan(0);
    report("text-chunk: defaults", s);
  });

  test("should handle chunkOverlap correctly", async () => {
    const s = snap();
    const shortText = "A".repeat(100);
    const result = await textChunker({
      text: shortText,
      chunkSize: 30,
      chunkOverlap: 10,
      strategy: ChunkingStrategy.FIXED,
    });

    expect(result.chunks.length).toBeGreaterThan(1);

    if (result.chunks.length > 1) {
      const firstChunkEnd = result.chunks[0].text.slice(-10);
      const secondChunkStart = result.chunks[1].text.slice(0, 10);
      expect(firstChunkEnd).toBe(secondChunkStart);
    }
    report("text-chunk: overlap", s);
  });

  test("should handle text shorter than chunkSize", async () => {
    const s = snap();
    const shortText = "Short text";
    const result = await textChunker({ text: shortText, chunkSize: 100, chunkOverlap: 10 });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toBe(shortText);
    report("text-chunk: short-text", s);
  });

  test("should handle empty text", async () => {
    const s = snap();
    const result = await textChunker({ text: "", chunkSize: 50 });
    expect(result.chunks).toBeDefined();
    report("text-chunk: empty", s);
  });

  test("should handle SEMANTIC strategy (aliased to sentence)", async () => {
    const s = snap();
    const result = await textChunker({
      text: testText,
      chunkSize: 80,
      chunkOverlap: 20,
      strategy: ChunkingStrategy.SEMANTIC,
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    report("text-chunk: semantic", s);
  });

  test("should handle very large chunkSize", async () => {
    const s = snap();
    const result = await textChunker({ text: testText, chunkSize: 10000, chunkOverlap: 0 });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toBe(testText);
    report("text-chunk: large-size", s);
  });

  // An overlap as large as the chunk never advances: the fixed strategy crawled one
  // character at a time, emitting a chunk per character.
  test.each([
    [50, 50],
    [30, 50],
  ])("refuses chunkSize %i with chunkOverlap %i, naming both", async (chunkSize, chunkOverlap) => {
    const err = await textChunker({ text: testText, chunkSize, chunkOverlap }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TaskInvalidInputError);
    expect(String((err as Error).message)).toContain(`chunkOverlap (${chunkOverlap})`);
    expect(String((err as Error).message)).toContain(`chunkSize (${chunkSize})`);
  });

  test("a small chunkSize with the overlap left unset is not refused for the default", async () => {
    const result = await textChunker({ text: testText, chunkSize: 30 });
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});
