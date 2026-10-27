/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ANTHROPIC, _testOnly } from "@workglow/anthropic/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/anthropic/ai-runtime";
import { getLogger } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ANTHROPIC_RUN_FNS, setAnthropicClientForTests } = _testOnly;

/** Request bodies handed to `messages.stream`, one per run. */
const sent: Record<string, unknown>[] = [];

const fakeClient = {
  messages: {
    stream: (params: Record<string, unknown>) => {
      sent.push(params);
      return { async *[Symbol.asyncIterator]() {} };
    },
  },
};

/** Capabilities whose run-fn asks the model for text, and so takes the effort dial. */
const GENERATIVE = new Set(["text.generation", "text.rewriter", "text.summary"]);

const generative = ANTHROPIC_RUN_FNS.filter((r) => r.serves.some((c) => GENERATIVE.has(c)));

const MAX_TOKENS = 100;

const input = {
  prompt: "hi",
  text: "some text",
  tools: [],
  outputSchema: { type: "object", properties: {} },
  maxTokens: MAX_TOKENS,
} as never;

const model = (modelName: string, effort?: string) =>
  ({
    model_id: modelName,
    title: modelName,
    description: "",
    provider: ANTHROPIC,
    provider_config: { model_name: modelName, api_key: "test-key", max_tokens: MAX_TOKENS },
    capabilities: ["text.generation"],
    metadata: {},
    ...(effort === undefined ? {} : { effort }),
  }) as never;

/** A run-fn on an empty stream may fail after its request is sent; only the request is checked. */
async function send(
  runFn: (typeof generative)[number]["runFn"],
  modelConfig: never
): Promise<Record<string, unknown>> {
  sent.length = 0;
  try {
    await runFn(input, modelConfig, new AbortController().signal, () => {}, undefined, undefined);
  } catch {
    // The request is what this suite inspects.
  }
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

const cases = generative.map((r) => [[...r.serves].join(","), r.runFn] as const);

describe("Anthropic effort reaches every generative run-fn", () => {
  beforeEach(() => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    setAnthropicClientForTests(fakeClient);
    runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);
  });

  afterEach(() => {
    setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests?.(undefined);
    vi.restoreAllMocks();
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

  it.each(cases)(
    "%s sends adaptive thinking at the set effort, with max_tokens padded for it",
    async (_serves, runFn) => {
      const params = await send(runFn, model("claude-sonnet-4-6", "high"));
      expect(params.thinking).toEqual({ type: "adaptive" });
      expect((params.output_config as { effort?: string }).effort).toBe("high");
      expect(params.max_tokens).toBe(MAX_TOKENS + 2048);
    }
  );

  it.each(cases)("%s sends no thinking before Claude 5 when effort is unset", async (_s, runFn) => {
    const params = await send(runFn, model("claude-sonnet-4-6"));
    expect("thinking" in params).toBe(false);
    expect((params.output_config as { effort?: string } | undefined)?.effort).toBeUndefined();
    expect(params.max_tokens).toBe(MAX_TOKENS);
  });

  it.each(cases)(
    "%s states adaptive thinking on Claude 5 when effort is unset",
    async (_s, runFn) => {
      const params = await send(runFn, model("claude-opus-5-5"));
      expect(params.thinking).toEqual({ type: "adaptive" });
      expect(params.max_tokens).toBe(MAX_TOKENS);
    }
  );
});
