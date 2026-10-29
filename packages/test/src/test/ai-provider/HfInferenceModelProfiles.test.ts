/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_EFFORTS } from "@workglow/ai";
import {
  hfiEffortPolicy,
  hfiReasoningParams,
  _testOnly as hfi,
  isHfInpaintingModel,
  resolveHfImageDims,
} from "@workglow/huggingface-inference/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  HFI_MODEL_PROFILES,
  normalizeHfiModelId,
  resolveHfiProfile,
  hfiProfileCapabilities,
  inferHfInferenceCapabilities,
} = hfi;

const config = (model_name: string, effort?: string) =>
  ({ provider: "HF_INFERENCE", provider_config: { model_name }, effort }) as never;

const infer = (model_id: string) =>
  inferHfInferenceCapabilities({ model_id, provider_config: { model_name: model_id } } as never);

describeModelProfileContract({
  provider: "Hugging Face Inference",
  resolve: resolveHfiProfile,
  rows: HFI_MODEL_PROFILES,
  normalize: normalizeHfiModelId,
  spellings: (id) => [id.toUpperCase(), `${id}:fal-ai`, ` ${id} `],
  normalizes: [
    ["black-forest-labs/FLUX.1-schnell", "black-forest-labs/flux.1-schnell"],
    ["openai/gpt-oss-120b:cerebras", "openai/gpt-oss-120b"],
    ["meta-llama/Llama-3.1-8B-Instruct:fastest", "meta-llama/llama-3.1-8b-instruct"],
  ],
  unlisted: [
    ["BAAI/bge-reranker-v2-m3", "family", true],
    ["Qwen/Qwen3-Reranker-8B", "family", true],
    ["openai/whisper-large-v3", "family", true],
    ["facebook/mms-tts-eng", "family", true],
    ["black-forest-labs/FLUX.1-Kontext-pro", "family", true],
    ["black-forest-labs/FLUX.1-dev", "family", true],
    ["diffusers/stable-diffusion-xl-1.0-inpainting-0.1", "family", true],
    ["stabilityai/stable-diffusion-xl-base-1.0", "family", true],
    ["kandinsky-community/kandinsky-2-2-decoder", "family", true],
    ["BAAI/bge-small-en-v1.5", "family", true],
    ["sentence-transformers/all-MiniLM-L6-v2", "family", true],
    ["intfloat/multilingual-e5-large", "family", true],
    ["Qwen/Qwen3-Embedding-8B", "family", true],
    ["meta-llama/Llama-3.1-8B-Instruct", "family", true],
    ["mistralai/Mistral-7B-Instruct-v0.3", "family", true],
    ["openai/gpt-oss-120b:cerebras", "family", true],
    ["moonshotai/Kimi-K2-Instruct", "default", false],
    ["totally-unknown-no-hints", "default", false],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const chat = profile.kind === "chat";
    const image = profile.kind === "image" ? profile : undefined;

    expect(hfiEffortPolicy(config(name))?.supported.length ?? 0).toBe(
      chat ? MODEL_EFFORTS.length : 0
    );
    expect(hfiReasoningParams(config(name, "high"))).toEqual(
      chat ? { reasoning_effort: "high" } : {}
    );

    expect(isHfInpaintingModel(name)).toBe(image?.masks === true);
    expect(resolveHfImageDims(name, "16:9").width).toBe(image?.dims === "flux" ? 1344 : 1280);

    const caps = infer(name);
    if (recognized) {
      expect(caps).toEqual(hfiProfileCapabilities(profile));
      expect(caps.includes("text.generation")).toBe(chat);
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("image.generation")).toBe(image?.generates === true);
      expect(caps.includes("image.editing")).toBe(image?.edits === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("Hugging Face Inference profile invariants", () => {
  it("keeps a record's declared capabilities ahead of the profile", () => {
    expect(
      inferHfInferenceCapabilities({
        model_id: "BAAI/bge-small-en-v1.5",
        capabilities: ["text.classification"],
      } as never)
    ).toEqual(["text.classification"]);
  });

  it("does not take a reranker for an embedding or a chat model", () => {
    for (const id of ["BAAI/bge-reranker-v2-m3", "Qwen/Qwen3-Reranker-8B"]) {
      expect(infer(id)).toEqual(["model.search", "model.info"]);
    }
  });

  it("gives every embedding and image family no effort dial", () => {
    for (const id of [
      "sentence-transformers/all-MiniLM-L6-v2",
      "intfloat/multilingual-e5-large",
      "kandinsky-community/kandinsky-2-2-decoder",
      "playgroundai/playground-v2.5-1024px-aesthetic",
    ]) {
      expect(hfiEffortPolicy(config(id))?.supported).toEqual([]);
    }
  });

  it("serves FLUX.1-schnell as generation only and Kontext-dev as editing only", () => {
    expect(infer("black-forest-labs/FLUX.1-schnell")).toEqual([
      "image.generation",
      "model.info",
      "model.search",
    ]);
    expect(infer("black-forest-labs/FLUX.1-Kontext-dev")).toEqual([
      "image.editing",
      "model.info",
      "model.search",
    ]);
  });
});
