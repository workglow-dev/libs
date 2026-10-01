/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { parseModelList, resolveModelConfig } from "../models";

describe("resolveModelConfig", () => {
  it("routes cloud ids to their provider by shape", () => {
    expect(resolveModelConfig("claude-haiku-4-5", "classify").provider).toBe("ANTHROPIC");
    expect(resolveModelConfig("gpt-5.5", "classify").provider).toBe("OPENAI");
    expect(resolveModelConfig("o3-mini", "classify").provider).toBe("OPENAI");
    expect(resolveModelConfig("text-embedding-3-small", "similarity").provider).toBe("OPENAI");
    expect(resolveModelConfig("gemini-3-flash-preview", "classify").provider).toBe("GOOGLE_GEMINI");
    expect(resolveModelConfig("grok-4.6", "classify").provider).toBe("XAI");
    expect(resolveModelConfig("deepseek-v4-flash", "classify").provider).toBe("DEEPSEEK");
    expect(resolveModelConfig("deepseek-v4-pro", "classify").provider).toBe("DEEPSEEK");
    expect(resolveModelConfig("deepseek-v4-pro-0813", "classify").provider).toBe("DEEPSEEK");
  });

  it("prices the DeepSeek V4 Pro 0813 GA snapshot at the published cache-miss rates", () => {
    const config = resolveModelConfig("deepseek-v4-pro-0813", "extract");
    expect(config.pricing).toEqual({
      currency: "USD",
      input: 1.32,
      output: 3.96,
      cached: 0.044,
      // Half rate outside DeepSeek's weekday peak hours, 01:00-04:00 and 06:00-10:00 UTC.
      timingTiers: [
        { start: "10:00", end: "01:00", pricing: { input: 0.66, output: 1.98, cached: 0.022 } },
        { start: "04:00", end: "06:00", pricing: { input: 0.66, output: 1.98, cached: 0.022 } },
      ],
    });
  });

  it("passes the id through as the provider model name", () => {
    const config = resolveModelConfig("claude-haiku-4-5", "classify");
    expect(config.provider_config.model_name).toBe("claude-haiku-4-5");
  });

  it("routes org/name paths to local HuggingFace ONNX with a kind-specific pipeline", () => {
    const embed = resolveModelConfig("Xenova/all-MiniLM-L6-v2", "similarity");
    expect(embed.provider).toBe("HF_TRANSFORMERS_ONNX");
    expect(embed.provider_config.pipeline).toBe("feature-extraction");
    expect(embed.provider_config.dtype).toBe("q8");

    const generate = resolveModelConfig("HuggingFaceTB/SmolLM2-360M-Instruct", "classify");
    expect(generate.provider_config.pipeline).toBe("text-generation");
    expect(generate.provider_config.dtype).toBe("q4");
  });

  it("routes org/name paths to local ONNX even when the org matches a cloud prefix", () => {
    expect(resolveModelConfig("gpt-omni/mini-omni", "classify").provider).toBe(
      "HF_TRANSFORMERS_ONNX"
    );
    expect(resolveModelConfig("o1-labs/some-model", "classify").provider).toBe(
      "HF_TRANSFORMERS_ONNX"
    );
  });

  it("honors a :dtype suffix on local model paths", () => {
    const config = resolveModelConfig("onnx-community/Qwen3-0.6B-ONNX:fp16", "classify");
    expect(config.provider_config.model_path).toBe("onnx-community/Qwen3-0.6B-ONNX");
    expect(config.provider_config.dtype).toBe("fp16");
  });

  it("rejects ids with no recognizable shape", () => {
    expect(() => resolveModelConfig("mystery-model", "classify")).toThrow(/cannot infer/);
  });

  it("routes gguf: ids to local node-llama-cpp with an hf: download url", () => {
    const config = resolveModelConfig("gguf:prism-ml/Bonsai-27B-gguf:Q1_0", "classify");
    expect(config.provider).toBe("LOCAL_LLAMACPP");
    expect(config.provider_config.model_url).toBe("hf:prism-ml/Bonsai-27B-gguf:Q1_0");
    expect(config.provider_config.model_path).toBeUndefined();
    expect(config.provider_config.models_dir).toMatch(/gguf$/);
    expect(config.provider_config.embedding).toBeUndefined();
  });

  it("passes through explicit hf:/https: gguf urls and local .gguf paths", () => {
    expect(
      resolveModelConfig("gguf:hf:prism-ml/Bonsai-27B-gguf:Q1_0", "classify").provider_config
        .model_url
    ).toBe("hf:prism-ml/Bonsai-27B-gguf:Q1_0");
    expect(
      resolveModelConfig("gguf:/tmp/models/Bonsai-27B-Q1_0.gguf", "classify").provider_config
        .model_path
    ).toBe("/tmp/models/Bonsai-27B-Q1_0.gguf");
  });

  it("enables embedding mode for gguf models on similarity evals", () => {
    const config = resolveModelConfig(
      "gguf:CompendiumLabs/bge-small-en-v1.5-gguf:Q8_0",
      "similarity"
    );
    expect(config.provider_config.embedding).toBe(true);
  });
});

describe("parseModelList", () => {
  it("trims, drops empties, and de-duplicates", () => {
    expect(parseModelList(" a, b ,,a ,c")).toEqual(["a", "b", "c"]);
  });
});
