/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as llamaCpp, llamaCppEffortPolicy } from "@workglow/node-llama-cpp/ai";
import {
  llamaCppChatSessionConstructorSpread,
  llamaCppThoughtBudget,
  loadSdk,
} from "@workglow/node-llama-cpp/ai-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeLlamaCppModelId,
  resolveLlamaCppProfile,
  resolveLlamaCppModelProfile,
  llamaCppProfileCapabilities,
  llamaCppQwenVariation,
  inferLlamaCppCapabilities,
} = llamaCpp;

const gguf = (model_path: string, extra: Record<string, unknown> = {}): never =>
  ({
    provider: "LOCAL_LLAMACPP",
    provider_config: { model_path },
    capabilities: [],
    ...extra,
  }) as never;

/** The `QwenChatWrapper` variation a session for this model is built with, if any. */
const sessionVariation = (model: never): string | undefined =>
  (
    llamaCppChatSessionConstructorSpread(model) as {
      chatWrapper?: { readonly variation: string };
    }
  ).chatWrapper?.variation;

beforeAll(async () => {
  await loadSdk();
});

describeModelProfileContract({
  provider: "node-llama-cpp",
  resolve: resolveLlamaCppProfile,
  rows: {},
  normalize: normalizeLlamaCppModelId,
  normalizes: [
    ["models/Qwen3.5-4B-Q4_K_M.gguf", "qwen3.5-4b-q4_k_m.gguf"],
    ["hf:unsloth/Qwen3-8B-GGUF:Q4_K_M", "qwen3-8b-gguf:q4_k_m"],
    [" bge-m3-q8_0.gguf ", "bge-m3-q8_0.gguf"],
  ],
  unlisted: [
    ["bge-m3-q8_0.gguf", "family", true],
    ["models/nomic-embed-text-v1.5.Q4_K_M.gguf", "family", true],
    ["all-MiniLM-L6-v2-Q8_0.gguf", "family", true],
    ["gte-small-q8_0.gguf", "family", true],
    ["multilingual-e5-large-q8_0.gguf", "family", true],
    ["Qwen3-Embedding-0.6B-Q8_0.gguf", "family", true],
    ["models/Qwen3.5-4B-Q4_K_M.gguf", "family", true],
    ["Qwen3-8B-Q4_K_M.gguf", "family", true],
    ["hf:unsloth/Qwen3-8B-GGUF:Q4_K_M", "family", true],
    ["Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf", "default", true],
    ["Mistral-7B-Instruct-v0.3.Q4_K_M.gguf", "default", true],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const model = gguf(name);
    expect(resolveLlamaCppModelProfile(model).profile).toBe(profile);

    expect(llamaCppEffortPolicy(model).supported).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "extra",
      "ultra",
    ]);
    expect(llamaCppThoughtBudget(gguf(name, { effort: "high" }))).toBe(2048);

    const caps = inferLlamaCppCapabilities(model);
    if (recognized) {
      expect(caps).toEqual(llamaCppProfileCapabilities(profile));
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("session.dispose")).toBe(profile.kind === "chat");
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }

    const variation = llamaCppQwenVariation(profile);
    expect(variation).toBe(
      profile.kind === "chat" && profile.chatWrapper !== "auto"
        ? profile.chatWrapper.slice("qwen".length)
        : undefined
    );
    expect(sessionVariation(model)).toBe(variation);
  },
});

describe("node-llama-cpp profile invariants", () => {
  it("places a generically named file by the URI it came from", () => {
    const model = gguf("models/model.gguf", {
      provider_config: {
        model_path: "models/model.gguf",
        model_url: "hf:Qwen/Qwen3-8B-GGUF:Q4_K_M",
      },
    });
    expect(resolveLlamaCppModelProfile(model).profile).toEqual({
      kind: "chat",
      chatWrapper: "qwen3",
    });
    expect(sessionVariation(model)).toBe("3");
  });

  it("reads the file before the record id", () => {
    const model = gguf("models/Qwen3.5-4B-Q4_K_M.gguf", { model_id: "qwen3-local" });
    expect(sessionVariation(model)).toBe("3.5");
  });

  it("does not read the title or description", () => {
    const model = gguf("models/Llama-3.2-1B-Instruct-Q4_K_M.gguf", {
      title: "Distilled from Qwen3",
      description: "An embedding-friendly Qwen 3.5 student",
    });
    expect(resolveLlamaCppModelProfile(model).profile).toEqual({
      kind: "chat",
      chatWrapper: "auto",
    });
    expect(sessionVariation(model)).toBeUndefined();
  });

  it("still trusts declared capabilities over the name", () => {
    expect(
      inferLlamaCppCapabilities(gguf("bge-m3-q8_0.gguf", { capabilities: ["text.generation"] }))
    ).toEqual(["text.generation"]);
  });

  it("builds no Qwen wrapper for a Qwen 3 embedding file", () => {
    expect(sessionVariation(gguf("Qwen3-Embedding-0.6B-Q8_0.gguf"))).toBeUndefined();
  });
});
