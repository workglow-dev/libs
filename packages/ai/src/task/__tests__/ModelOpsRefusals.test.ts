/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";
import {
  AiProviderRegistry,
  HierarchicalChunkerTask,
  ModelInfoTask,
  ModelSearchTask,
  setAiProviderRegistry,
} from "@workglow/ai";
import { StructuralParser } from "@workglow/knowledge-base";
import type { IExecuteContext } from "@workglow/task-graph";
import { TaskConfigurationError, TaskInvalidInputError } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

// A refusal the caller or host can fix is a TaskError subclass naming what to fix, so the
// runner keeps it as thrown instead of recording a generic task failure.
const context = {
  signal: new AbortController().signal,
  updateProgress: async () => {},
  own: <T>(task: T): T => task,
} as unknown as IExecuteContext;

describe("model operations refuse with task errors", () => {
  it("a provider with no model.info or model.search run-fn is a configuration error", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const model = {
      model_id: "m",
      title: "m",
      description: "",
      capabilities: [],
      provider: "no-such-provider",
      provider_config: {},
      metadata: {},
    } as ModelConfig;
    await expect(new ModelInfoTask().execute({ model } as never, context)).rejects.toBeInstanceOf(
      TaskConfigurationError
    );
    await expect(
      new ModelSearchTask().execute({ provider: "no-such-provider", query: "x" } as never, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
  });

  it("a hierarchical chunker budget that leaves no room is invalid input", async () => {
    const documentTree = await StructuralParser.parseMarkdown(
      "doc",
      "# Title\n\n" + "word ".repeat(400),
      "Title"
    );
    const run = (budget: Record<string, number>) =>
      new HierarchicalChunkerTask().execute(
        { doc_id: "doc", documentTree, ...budget } as never,
        context
      );
    await expect(run({ maxTokens: 20, reservedTokens: 20, overlap: 0 })).rejects.toBeInstanceOf(
      TaskInvalidInputError
    );
    await expect(run({ maxTokens: 20, reservedTokens: 0, overlap: 30 })).rejects.toBeInstanceOf(
      TaskInvalidInputError
    );
    await expect(
      new HierarchicalChunkerTask().execute({ documentTree } as never, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
  });
});
