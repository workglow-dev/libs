/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import "@workglow/ai"; // Trigger Workflow prototype extensions
import { documentUpsert } from "@workglow/ai";
import { TaskInvalidInputError } from "@workglow/task-graph";
import type { DocumentMetadata, KnowledgeBase } from "@workglow/knowledge-base";
import { createKnowledgeBase, StructuralParser } from "@workglow/knowledge-base";
import { setLogger, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { report, snap } from "../../binding/testTiming";

setLogger(getTestingLogger());

let _snap = snap();
beforeEach(() => {
  _snap = snap();
});
afterEach(() => {
  report("doc-upsert", _snap);
});

describe("DocumentUpsertTask", () => {
  let kb: KnowledgeBase;

  beforeEach(async () => {
    kb = await createKnowledgeBase({
      name: `test-doc-upsert-${uuid4()}`,
      vectorDimensions: 3,
      register: false,
    });
  });

  afterEach(() => {
    kb.destroy();
  });

  async function makeTree(title: string) {
    const doc_id = uuid4();
    const root = await StructuralParser.parseMarkdown(doc_id, "# Test\n\nContent.", title);
    return { doc_id, root };
  }

  it("accepts the legacy title-only shortcut", async () => {
    const { doc_id, root } = await makeTree("Legacy Title");
    await documentUpsert({
      knowledgeBase: kb,
      doc_id,
      documentTree: root,
      title: "Legacy Title",
    });
    const doc = await kb.getDocument(doc_id);
    expect(doc?.metadata.title).toBe("Legacy Title");
  });

  it("accepts a metadata object with title plus extras and persists every field", async () => {
    const { doc_id, root } = await makeTree("Metadata Title");
    const metadata: DocumentMetadata = {
      title: "Metadata Title",
      sourceUri: "/raw/workglow.dev/blog/post/example.mdx",
      createdAt: "2026-05-04",
      // Open schema (additionalProperties: true) — extras pass through unchanged.
      author: "Workglow Team",
      tags: ["task-graph"],
    } as DocumentMetadata;
    await documentUpsert({ knowledgeBase: kb, doc_id, documentTree: root, metadata });
    const doc = await kb.getDocument(doc_id);
    expect(doc?.metadata.title).toBe("Metadata Title");
    expect(doc?.metadata.sourceUri).toBe("/raw/workglow.dev/blog/post/example.mdx");
    expect((doc!.metadata as Record<string, unknown>).author).toBe("Workglow Team");
    expect((doc!.metadata as Record<string, unknown>).tags).toEqual(["task-graph"]);
  });

  it("lets explicit title override metadata.title when both are provided", async () => {
    const { doc_id, root } = await makeTree("Original");
    await documentUpsert({
      knowledgeBase: kb,
      doc_id,
      documentTree: root,
      title: "Override",
      metadata: { title: "Original", sourceUri: "/x.mdx" },
    });
    const doc = await kb.getDocument(doc_id);
    expect(doc?.metadata.title).toBe("Override");
    expect(doc?.metadata.sourceUri).toBe("/x.mdx");
  });

  it("throws when neither title nor metadata.title is provided", async () => {
    const { doc_id, root } = await makeTree("placeholder");
    const refusal = documentUpsert({
      knowledgeBase: kb,
      doc_id,
      documentTree: root,
      metadata: { sourceUri: "/x.mdx" } as unknown as DocumentMetadata,
    });
    await expect(refusal).rejects.toBeInstanceOf(TaskInvalidInputError);
    await expect(
      documentUpsert({
        knowledgeBase: kb,
        doc_id,
        documentTree: root,
        // Deliberately missing both title fields. We cast through unknown to
        // bypass the input typing for this negative test, but the runtime check
        // in execute() should reject it.
        metadata: { sourceUri: "/x.mdx" } as unknown as DocumentMetadata,
      })
    ).rejects.toThrow(/title is required/i);
  });
});
