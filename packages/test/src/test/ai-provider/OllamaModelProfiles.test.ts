/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as ollama, ollamaEffortPolicy, ollamaThinkParam } from "@workglow/ollama/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeOllamaModelId,
  resolveOllamaProfile,
  ollamaProfileCapabilities,
  inferOllamaCapabilities,
} = ollama;

const model = (model_name: string, effort?: string): never =>
  ({
    provider: "OLLAMA",
    provider_config: { model_name },
    ...(effort === undefined ? {} : { effort }),
  }) as never;

describeModelProfileContract({
  provider: "Ollama",
  resolve: resolveOllamaProfile,
  rows: {},
  normalize: normalizeOllamaModelId,
  normalizes: [
    ["qwen3:8b", "qwen3:8b"],
    ["Qwen3:8B", "qwen3:8b"],
    ["nomic-embed-text:latest", "nomic-embed-text"],
    ["library/qwen3:8b", "qwen3:8b"],
    ["registry.ollama.ai/library/llama3.2:latest", "llama3.2"],
    ["hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M", "qwen3-8b-gguf:q4_k_m"],
    ["localhost:5000/team/gpt-oss:20b", "gpt-oss:20b"],
    ["  gpt-oss:20b ", "gpt-oss:20b"],
  ],
  unlisted: [
    ["nomic-embed-text:latest", "family", true],
    ["nomic-embed-text:v1.5", "family", true],
    ["mxbai-embed-large", "family", true],
    ["all-minilm:33m", "family", true],
    ["snowflake-arctic-embed:335m", "family", true],
    ["nomic-embed-text-v2-moe", "family", true],
    ["bge-m3", "family", true],
    ["gte-qwen2:7b", "family", true],
    ["qwen3-embedding:8b", "family", true],
    ["llava:13b", "family", true],
    ["bakllava", "family", true],
    ["llama3.2-vision:11b", "family", true],
    ["granite3.2-vision:2b", "family", true],
    ["gpt-oss:20b", "family", true],
    ["qwen3:8b", "family", true],
    ["qwen3:30b-a3b-thinking-2507", "family", true],
    ["hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M", "family", true],
    ["deepseek-r1:7b", "family", true],
    ["deepseek-v3.1:671b", "family", true],
    ["magistral:24b", "family", true],
    ["qwq", "family", true],
    ["phi4-reasoning:14b", "family", true],
    ["cogito:8b", "family", true],
    ["granite3.3:8b", "family", true],
    ["qwen3-coder:30b", "default", true],
    ["qwen3:30b-a3b-instruct-2507", "default", true],
    ["deepseek-v3", "default", true],
    ["granite3.1-dense:8b", "default", true],
    ["llama3.2", "default", true],
    ["my-custom-finetune", "default", true],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const chat = profile.kind === "chat" ? profile : undefined;
    const effort = ollamaEffortPolicy(model(name)).supported;
    expect(effort.length > 0).toBe(chat !== undefined && chat.think !== "none");
    expect(effort.includes("none")).toBe(chat?.think === "boolean");

    const think = ollamaThinkParam(model(name, "high")).think;
    switch (chat?.think) {
      case "levels":
        expect(think).toBe("high");
        break;
      case "boolean":
        expect(think).toBe(true);
        expect(ollamaThinkParam(model(name, "none")).think).toBe(false);
        break;
      default:
        expect(think).toBeUndefined();
    }

    const caps = inferOllamaCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(ollamaProfileCapabilities(profile));
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("vision-input")).toBe(chat?.vision === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("Ollama profile invariants", () => {
  it("reads a namespaced name as the library name it spells", () => {
    for (const spelled of ["library/qwen3:8b", "registry.ollama.ai/library/qwen3:8b"]) {
      expect(ollamaThinkParam(model(spelled, "high"))).toEqual({ think: true });
    }
    expect(
      inferOllamaCapabilities({ model_id: "hf.co/CompendiumLabs/bge-base-en" } as never)
    ).toEqual(["text.embedding", "model.info", "model.search"]);
  });

  it("keeps the offline embedding width for every tag of a known model", () => {
    for (const spelled of [
      "nomic-embed-text",
      "nomic-embed-text:v1.5",
      "library/nomic-embed-text",
    ]) {
      expect(resolveOllamaProfile(spelled).profile).toEqual({
        kind: "embedding",
        dimensions: { native: 768, mrl: false },
      });
    }
    expect(resolveOllamaProfile("nomic-embed-text-v2-moe").profile).toEqual({
      kind: "embedding",
      dimensions: undefined,
    });
  });

  it("reads a qwen3 variant's thinking from its tag", () => {
    expect(resolveOllamaProfile("qwen3:30b-a3b-instruct-2507").profile).toMatchObject({
      think: "none",
    });
    expect(resolveOllamaProfile("qwen3:30b-a3b-thinking-2507").profile).toMatchObject({
      think: "boolean",
    });
  });
});
