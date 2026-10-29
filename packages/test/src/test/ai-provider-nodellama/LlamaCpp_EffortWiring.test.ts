/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlamaCppModelRecord } from "@workglow/node-llama-cpp/ai";
import { _testOnly, LOCAL_LLAMACPP } from "@workglow/node-llama-cpp/ai";
import { llamaCppTextContexts } from "@workglow/node-llama-cpp/ai-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The generation options each run-fn handed the SDK, one per prompt / generateResponse. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("node-llama-cpp", () => {
  const fakeContext = {
    get sequencesLeft() {
      return 4;
    },
    getSequence() {
      return { nextTokenIndex: 0, dispose: async () => {} };
    },
    dispose: async () => {},
  };
  return {
    getLlama: async () => ({
      loadModel: async () => ({ createContext: async () => fakeContext }),
      createGrammarForJsonSchema: async () => ({}),
    }),
    LlamaChatSession: class {
      setChatHistory(): void {}
      getChatHistory(): unknown[] {
        return [];
      }
      async preloadPrompt(): Promise<void> {}
      async prompt(
        _text: string,
        options: { readonly onTextChunk?: (chunk: string) => void } & Record<string, unknown>
      ): Promise<string> {
        sent.push(options);
        options.onTextChunk?.("{}");
        return "{}";
      }
      dispose(): void {}
    },
    LlamaChat: class {
      async generateResponse(
        history: unknown[],
        options: { readonly onResponseChunk?: (chunk: { text: string }) => void } & Record<
          string,
          unknown
        >
      ): Promise<unknown> {
        sent.push(options);
        options.onResponseChunk?.({ text: "ok" });
        return { functionCalls: [], lastEvaluation: { cleanHistory: history } };
      }
      dispose(): void {}
    },
  };
});

/** Capabilities whose run-fn asks the model for text, and so takes the effort dial. */
const GENERATIVE = new Set(["text.generation", "text.rewriter", "text.summary"]);

const generative = _testOnly.LLAMACPP_RUN_FNS.filter((r) =>
  r.serves.some((c) => GENERATIVE.has(c))
);

const MODEL_PATH = "/tmp/effort-wiring.gguf";

const model = (effort?: string): LlamaCppModelRecord =>
  ({
    model_id: "llamacpp:effort-wiring",
    title: "effort wiring",
    description: "",
    capabilities: ["text.generation"],
    provider: LOCAL_LLAMACPP,
    provider_config: { model_path: MODEL_PATH },
    metadata: {},
    ...(effort === undefined ? {} : { effort }),
  }) as LlamaCppModelRecord;

const promptInput = {
  prompt: "hi",
  text: "some text",
  tools: [],
  outputSchema: { type: "object", properties: {} },
} as any;

/** The unified text-generation run-fn takes the chat path when `messages` is populated. */
const chatInput = {
  ...promptInput,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as any;

describe("node-llama-cpp effort reaches every generative run-fn", () => {
  beforeEach(() => {
    sent.length = 0;
    llamaCppTextContexts.clear();
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

  const cases = generative.flatMap((r) => {
    const serves = [...r.serves].join(",");
    const base = [[serves, r.runFn, promptInput] as const];
    return serves === "text.generation"
      ? [...base, [`${serves} (chat)`, r.runFn, chatInput] as const]
      : base;
  });

  it.each(cases)(
    "%s sends a thought budget for a set effort and nothing when unset",
    async (_serves, runFn, input) => {
      const signal = new AbortController().signal;
      await runFn(input, model("high"), signal, () => {}, undefined, undefined);
      await runFn(input, model("none"), signal, () => {}, undefined, undefined);
      await runFn(input, model(), signal, () => {}, undefined, undefined);
      expect(sent.map((options) => options.budgets)).toEqual([
        { thoughtTokens: 2048 },
        { thoughtTokens: 0 },
        undefined,
      ]);
      expect("budgets" in sent[2]!).toBe(false);
    }
  );
});
