/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as server } from "@workglow/llamacpp-server/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeLlamaCppServerModelId,
  resolveLlamaCppServerProfile,
  llamaCppServerProfileCapabilities,
  inferLlamaCppServerCapabilities,
} = server;

describeModelProfileContract({
  provider: "llama.cpp server",
  resolve: resolveLlamaCppServerProfile,
  rows: {},
  normalize: normalizeLlamaCppServerModelId,
  normalizes: [
    ["/models/Qwen3-8B-Q4_K_M.gguf", "qwen3-8b-q4_k_m.gguf"],
    ["models/bge-m3-q8_0.gguf", "bge-m3-q8_0.gguf"],
    ["llama-3-8b-q4_k_m.gguf", "llama-3-8b-q4_k_m.gguf"],
  ],
  unlisted: [
    ["/models/nomic-embed-text-v1.5.Q4_K_M.gguf", "family", true],
    ["bge-m3-q8_0.gguf", "family", true],
    ["models/gte-small.gguf", "family", true],
    ["all-MiniLM-L6-v2-Q8_0.gguf", "family", true],
    ["Qwen3-Embedding-0.6B-Q8_0.gguf", "family", true],
    ["/models/llava-7b-v1.6-q4_k_m.gguf", "family", true],
    ["bakllava-q5.gguf", "family", true],
    ["Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf", "family", true],
    ["models/Qwen3.5-4B-Q4_K_M.gguf", "default", true],
    ["llama-3-8b-q4_k_m.gguf", "default", true],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const caps = inferLlamaCppServerCapabilities({
      model_id: name,
      provider_config: { model_path: name },
    } as never);
    if (recognized) {
      expect(caps).toEqual(llamaCppServerProfileCapabilities(profile));
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("vision-input")).toBe(profile.kind === "chat" && profile.vision);
      // This provider serves no json-mode run-fn, so no profile advertises one.
      expect(caps).not.toContain("json-mode");
    } else {
      expect(caps).toEqual(["model.info", "model.search"]);
    }
  },
});

describe("llama.cpp server profile invariants", () => {
  it("reads native_dimensions ahead of the file name", () => {
    expect(
      inferLlamaCppServerCapabilities({
        model_id: "Qwen3-8B-Q4_K_M.gguf",
        provider_config: { model_path: "/models/Qwen3-8B-Q4_K_M.gguf", native_dimensions: 768 },
      } as never)
    ).toEqual(["text.embedding", "model.info", "model.search"]);
  });

  it("reads the file name, not the directory it sits in", () => {
    expect(resolveLlamaCppServerProfile("/srv/embeddings/llama-3-8b.gguf").profile).toEqual({
      kind: "chat",
      vision: false,
    });
  });
});
