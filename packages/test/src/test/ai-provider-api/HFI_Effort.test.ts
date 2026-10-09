/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly, hfiEffortPolicy, hfiReasoningParams } from "@workglow/huggingface-inference/ai";
import { describe, expect, it } from "vitest";

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

  it("is what the provider reports for a model", () => {
    const provider = new _testOnly.HfInferenceQueuedProvider() as any;
    expect(provider.effortPolicy(model("high"))?.supported).toContain("high");
    expect(provider.effortPolicy(model(undefined, "BAAI/bge-small-en-v1.5"))?.supported).toEqual(
      []
    );
  });
});
