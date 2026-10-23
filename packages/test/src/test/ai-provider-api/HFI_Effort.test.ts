/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly, hfiEffortPolicy, hfiReasoningParams } from "@workglow/huggingface-inference/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const model = (effort?: string, model_name = "openai/gpt-oss-120b") =>
  ({ provider_config: { model_name }, ...(effort ? { effort } : {}) }) as any;

describe("Hugging Face Inference effort", () => {
  it("sends reasoning_effort for a set effort", () => {
    expect(hfiReasoningParams(model("high"))).toEqual({ reasoning_effort: "high" });
    expect(hfiReasoningParams(model("low"))).toEqual({ reasoning_effort: "low" });
  });

  it("maps extra and ultra to high and sends nothing for none or unset", () => {
    expect(hfiReasoningParams(model("ultra"))).toEqual({ reasoning_effort: "high" });
    expect(hfiReasoningParams(model("extra"))).toEqual({ reasoning_effort: "high" });
    expect(hfiReasoningParams(model("none"))).toEqual({});
    expect(hfiReasoningParams(model())).toEqual({});
  });

  it("gives embedding models no effort", () => {
    expect(hfiEffortPolicy(model(undefined, "BAAI/bge-small-en-v1.5")).supported).toEqual([]);
    expect(hfiReasoningParams(model("high", "BAAI/bge-small-en-v1.5"))).toEqual({});
  });

  it("excludes whisper and tts ids by name, not by substring", () => {
    expect(hfiEffortPolicy(model(undefined, "openai/whisper-large-v3")).supported).toEqual([]);
    expect(hfiEffortPolicy(model(undefined, "hexgrad/tts-1")).supported).toEqual([]);
    expect(hfiEffortPolicy(model(undefined, "org/matts-chat")).supported).toContain("high");
    expect(hfiReasoningParams(model("high", "org/matts-chat"))).toEqual({
      reasoning_effort: "high",
    });
  });

  it("is what the provider reports for a model", () => {
    const provider = new _testOnly.HfInferenceQueuedProvider() as any;
    expect(provider.effortPolicy(model("high"))?.supported).toContain("high");
    expect(provider.effortPolicy(model(undefined, "BAAI/bge-small-en-v1.5"))?.supported).toEqual(
      []
    );
  });
});

/** Capabilities whose run-fn asks the model for text, and so takes the effort dial. */
const GENERATIVE = new Set(["text.generation", "text.rewriter", "text.summary"]);

const generative = _testOnly.HFI_RUN_FNS.filter((r) => r.serves.some((c) => GENERATIVE.has(c)));

describe("Hugging Face Inference effort reaches every generative run-fn", () => {
  let sent: Record<string, unknown>[] = [];
  class CapturingClient {
    chatCompletionStream(params: Record<string, unknown>) {
      sent.push(params);
      return (async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      })();
    }
  }

  beforeEach(() => {
    sent = [];
    _testOnly._setHfInferenceSDKForTesting({ InferenceClient: CapturingClient } as any);
  });

  afterEach(() => {
    _testOnly._setHfInferenceSDKForTesting(undefined);
  });

  const withKey = (effort?: string) => ({
    ...model(effort),
    provider_config: { model_name: "openai/gpt-oss-120b", api_key: "k" },
  });

  it("covers every generative registration", () => {
    expect(generative.map((r) => [...r.serves].sort().join(",")).sort()).toEqual(
      expect.arrayContaining([
        "text.generation",
        "text.generation,tool-use",
        "text.rewriter",
        "text.summary",
      ])
    );
  });

  it.each(generative.map((r) => [[...r.serves].join(","), r.runFn] as const))(
    "%s sends reasoning_effort for a set effort and nothing when unset",
    async (_serves, runFn) => {
      const input = { prompt: "hi", text: "some text", tools: [] } as any;
      const signal = new AbortController().signal;
      await runFn(input, withKey("high"), signal, () => {}, undefined, undefined);
      await runFn(input, withKey(), signal, () => {}, undefined, undefined);
      expect(sent.map((params) => params.reasoning_effort)).toEqual(["high", undefined]);
      expect("reasoning_effort" in sent[1]!).toBe(false);
    }
  );
});
