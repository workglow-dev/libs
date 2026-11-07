/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DocumentEnricherTask, QueryExpanderTask, RerankerTask } from "@workglow/ai";
import type { ModelConfig } from "@workglow/ai";
import type { IExecuteContext } from "@workglow/task-graph";
import { StructuralParser } from "@workglow/knowledge-base";
import { describe, expect, it } from "vitest";

/** Counts the summaries in flight instead of calling a model. */
class CountingEnricher extends DocumentEnricherTask {
  public inFlight = 0;
  public peak = 0;
  public calls = 0;
  protected override async summarize(): Promise<string> {
    this.calls++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight--;
    return "summary";
  }
}

async function bigDocument(sections: number) {
  const body = Array.from(
    { length: sections },
    (_, i) => `# Section ${i}\n\n${"Some section text. ".repeat(10)}`
  ).join("\n\n");
  return StructuralParser.parseMarkdown("doc", body, "Doc");
}

const context = {
  signal: new AbortController().signal,
  own: <T>(task: T) => task,
} as unknown as IExecuteContext;

// Every node's summary used to go out at once: a 500-section document put ~1,000
// model calls in flight, bounded only when the provider happened to be queued.
describe("DocumentEnricherTask bounds its model calls", () => {
  it.each([
    [undefined, 4],
    [2, 2],
  ] as const)("with concurrency %s, at most %i summaries run at once", async (concurrency, cap) => {
    const task = new CountingEnricher(concurrency ? ({ concurrency } as never) : undefined);
    await task.execute(
      {
        doc_id: "doc",
        documentTree: await bigDocument(30),
        summaryModel: { provider: "fake", model_id: "fake" } as unknown as ModelConfig,
        summaryThreshold: 1,
        extractEntities: false,
      },
      context
    );
    expect(task.calls).toBeGreaterThan(cap);
    expect(task.peak).toBe(cap);
  });

  it("declares concurrency in its config schema", () => {
    const schema = DocumentEnricherTask.configSchema() as {
      properties: Record<string, { default?: unknown; minimum?: number }>;
    };
    expect(schema.properties.concurrency).toMatchObject({ default: 4, minimum: 1 });
  });
});

// Heuristic tasks call no model, so they require no capability of one.
describe("heuristic RAG tasks declare no model capability", () => {
  it.each([
    ["RerankerTask", RerankerTask],
    ["QueryExpanderTask", QueryExpanderTask],
  ] as const)("%s requires nothing", (_name, T) => {
    expect(T.requires).toEqual([]);
  });
});
