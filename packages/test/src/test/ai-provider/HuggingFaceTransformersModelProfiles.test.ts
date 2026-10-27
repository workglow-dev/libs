/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as hft } from "@workglow/huggingface-transformers/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  HFT_PIPELINE_TASK_PROFILES,
  normalizeHftModelId,
  resolveHftProfile,
  resolveHftRecordProfile,
  hftProfileCapabilities,
  inferHftCapabilities,
} = hft;

const record = (model_id: string, provider_config: Record<string, unknown> = {}) =>
  ({ model_id, provider_config: { model_path: model_id, ...provider_config } }) as never;

describeModelProfileContract({
  provider: "HuggingFace Transformers",
  resolve: resolveHftProfile,
  rows: {},
  normalize: normalizeHftModelId,
  normalizes: [
    ["Xenova/bge-reranker-base", "bge-reranker-base"],
    ["onnx-community/Qwen3-0.6B-ONNX", "qwen3-0.6b-onnx"],
    [" clip-vit-base-patch32 ", "clip-vit-base-patch32"],
  ],
  unlisted: [
    ["Xenova/bge-reranker-base", "family", true],
    ["Xenova/language-detection", "family", true],
    ["papluca/xlm-roberta-base-langid", "family", true],
    ["Xenova/bge-small-en-v1.5", "family", true],
    ["Xenova/all-MiniLM-L6-v2", "family", true],
    ["Xenova/clip-vit-base-patch32", "family", true],
    ["Xenova/siglip-base-patch16-224", "family", true],
    ["Xenova/yolos-tiny", "family", true],
    ["Xenova/detr-resnet-50", "family", true],
    ["Xenova/slimsam-77-uniform", "family", true],
    ["Xenova/segformer-b0-finetuned-ade-512-512", "family", true],
    ["Xenova/blip-image-captioning-base", "family", true],
    ["HuggingFaceTB/SmolVLM-256M-Instruct", "family", true],
    ["onnx-community/Qwen2-VL-2B-Instruct", "family", true],
    ["onnx-community/llava-onevision-qwen2-0.5b-ov-hf", "family", true],
    ["onnx-community/Qwen3-0.6B-ONNX", "family", true],
    ["onnx-community/Llama-3.2-1B-Instruct-q4f16", "family", true],
    ["HuggingFaceTB/SmolLM2-135M-Instruct", "family", true],
    ["Xenova/distilbert-base-uncased", "default", false],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const caps = inferHftCapabilities(record(name));
    expect(caps).toEqual(hftProfileCapabilities(profile));
    expect(resolveHftRecordProfile(record(name)).profile).toBe(profile);
    if (!recognized) expect(caps).toEqual(["model.search", "model.info"]);
  },
});

describe("HuggingFace Transformers profile precedence", () => {
  it("serves a reranker before the embedding family it shares `bge-` with", () => {
    expect(resolveHftProfile("Xenova/bge-reranker-base").profile.kind).toBe("text-reranking");
    expect(resolveHftProfile("Xenova/bge-small-en-v1.5").profile.kind).toBe("text-embedding");
  });

  it("reads the family off the repo name, never its owner", () => {
    expect(resolveHftProfile("mask-org/plain-model").recognized).toBe(false);
  });

  it("reads `pipeline_task` ahead of the name", () => {
    for (const [task, taskProfile] of Object.entries(HFT_PIPELINE_TASK_PROFILES)) {
      const resolved = resolveHftRecordProfile(
        record("onnx-community/Qwen3-0.6B-ONNX", { pipeline_task: task })
      );
      expect([task, resolved.source, resolved.profile]).toEqual([
        task,
        "pipeline-task",
        taskProfile,
      ]);
      expect(
        inferHftCapabilities(record("onnx-community/Qwen3-0.6B-ONNX", { pipeline_task: task }))
      ).toEqual(hftProfileCapabilities(taskProfile));
    }
  });

  it("falls through to the name for a `pipeline_task` it does not serve", () => {
    const resolved = resolveHftRecordProfile(
      record("Xenova/clip-vit-base-patch32", { pipeline_task: "depth-estimation" })
    );
    expect([resolved.source, resolved.profile.kind]).toEqual([
      "family",
      "zero-shot-image-classification",
    ]);
  });

  it("reads the pipeline a record loads with over its hint and its name", () => {
    // An image-text-to-text load is a vision-language model whatever it is called.
    expect(
      resolveHftRecordProfile(
        record("Xenova/clip-vit-base-patch32", {
          pipeline: "image-text-to-text",
          pipeline_task: "zero-shot-image-classification",
        })
      ).profile.kind
    ).toBe("vision-language");
    // Any other load runs text-only, so neither a vision-language name nor hint counts.
    for (const config of [{}, { pipeline_task: "image-text-to-text" }]) {
      const resolved = resolveHftRecordProfile(
        record("onnx-community/Qwen2-VL-2B-Instruct", { pipeline: "text-generation", ...config })
      );
      expect(resolved.profile.kind).toBe("text-generation");
    }
    // A name no family knows falls back to the load.
    expect(
      resolveHftRecordProfile(record("someone/mystery-model", { pipeline: "fill-mask" }))
    ).toEqual({
      profile: HFT_PIPELINE_TASK_PROFILES["fill-mask"],
      source: "pipeline",
      recognized: true,
    });
  });

  it("keeps declared capabilities over every profile", () => {
    expect(
      inferHftCapabilities({
        model_id: "onnx-community/Qwen3-0.6B-ONNX",
        provider_config: {},
        capabilities: ["text.embedding"],
      } as never)
    ).toEqual(["text.embedding"]);
  });
});
