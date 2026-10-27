/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GOOGLE_GEMINI, _testOnly } from "@workglow/google-gemini/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/google-gemini/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Requests handed to `generateContentStream`, one per run. */
const sent: Array<{ readonly config: Record<string, unknown> }> = [];

const fakeGeminiClient = {
  models: {
    generateContentStream: async (request: { readonly config: Record<string, unknown> }) => {
      sent.push(request);
      return { async *[Symbol.asyncIterator]() {} };
    },
  },
  caches: { create: async () => ({}), delete: async () => {} },
} as never;

/** Capabilities whose run-fn asks the model for text, and so takes the effort dial. */
const GENERATIVE = new Set(["text.generation", "text.rewriter", "text.summary"]);

const generative = _testOnly.GEMINI_RUN_FNS.filter((r) => r.serves.some((c) => GENERATIVE.has(c)));

const input = {
  prompt: "hi",
  text: "some text",
  tools: [],
  outputSchema: { type: "object", properties: {} },
} as never;

const model = (effort?: string) =>
  ({
    provider: GOOGLE_GEMINI,
    provider_config: { api_key: "test-key", model_name: "gemini-2.5-flash" },
    ...(effort === undefined ? {} : { effort }),
  }) as never;

describe("Gemini effort reaches every generative run-fn", () => {
  beforeEach(() => {
    sent.length = 0;
    _testOnly.setGeminiClientForTests(fakeGeminiClient);
    runtimeTestOnly.setGeminiClientForTests(fakeGeminiClient);
  });

  afterEach(() => {
    _testOnly.setGeminiClientForTests(undefined);
    runtimeTestOnly.setGeminiClientForTests(undefined);
  });

  it("covers every generative registration", () => {
    expect(generative.map((r) => [...r.serves].sort().join(",")).sort()).toEqual(
      expect.arrayContaining([
        "json-mode,text.generation",
        "text.generation",
        "text.generation,tool-use",
        "text.rewriter",
        "text.summary",
      ])
    );
  });

  it.each(generative.map((r) => [[...r.serves].join(","), r.runFn] as const))(
    "%s sends a thinking budget for a set effort and none when unset",
    async (_serves, runFn) => {
      const signal = new AbortController().signal;
      await runFn(input, model("high"), signal, () => {}, undefined, undefined);
      await runFn(input, model("none"), signal, () => {}, undefined, undefined);
      await runFn(input, model(), signal, () => {}, undefined, undefined);
      const budgets = sent.map(
        (request) =>
          (request.config.thinkingConfig as { thinkingBudget?: number } | undefined)?.thinkingBudget
      );
      expect(budgets).toEqual([2048, 0, undefined]);
    }
  );

  it.each(
    generative
      .filter((r) => r.serves.some((c) => c === "text.rewriter" || c === "text.summary"))
      .map((r) => [[...r.serves].join(","), r.runFn] as const)
  )("%s sends no thinking config at all when effort is unset", async (_serves, runFn) => {
    await runFn(input, model(), new AbortController().signal, () => {}, undefined, undefined);
    expect("thinkingConfig" in sent[0]!.config).toBe(false);
  });
});
