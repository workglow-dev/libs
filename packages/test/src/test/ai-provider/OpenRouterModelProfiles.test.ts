/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRecord } from "@workglow/ai";
import { MODEL_EFFORTS } from "@workglow/ai";
import {
  inferOpenRouterCapabilities,
  OPENROUTER,
  openrouterEffortPolicy,
  _testOnly as openrouter,
} from "@workglow/openrouter/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeOpenRouterModelId,
  resolveOpenRouterProfile,
  openRouterProfileCapabilities,
  buildOpenRouterExtras,
  mapOpenRouterModels,
} = openrouter;

const record = (model_name: string, metadata: Record<string, unknown> = {}): ModelRecord =>
  ({
    model_id: model_name,
    title: model_name,
    description: "",
    provider: OPENROUTER,
    provider_config: { model_name },
    capabilities: [],
    metadata,
  }) as ModelRecord;

describeModelProfileContract({
  provider: "OpenRouter",
  resolve: resolveOpenRouterProfile,
  rows: {},
  normalize: normalizeOpenRouterModelId,
  normalizes: [
    ["openai/gpt-5", "openai/gpt-5"],
    [" OpenAI/GPT-5 ", "openai/gpt-5"],
    ["meta-llama/llama-3.3-70b-instruct:free", "meta-llama/llama-3.3-70b-instruct"],
    ["anthropic/claude-3.7-sonnet:thinking", "anthropic/claude-3.7-sonnet"],
  ],
  unlisted: [
    ["openai/text-embedding-3-small", "family", true],
    ["qwen/qwen3-embedding-8b", "family", true],
    ["mistralai/mistral-embed", "family", true],
    ["black-forest-labs/flux-1.1-pro", "family", true],
    ["black-forest-labs/flux.1-schnell", "family", true],
    ["openai/gpt-image-1", "family", true],
    ["google/gemini-2.5-flash-image", "family", true],
    ["google/gemini-2.5-flash-image:free", "family", true],
    ["openai/whisper-1", "family", true],
    ["openai/whisper-large-v3", "family", true],
    ["cohere/rerank-v3.5", "family", true],
    ["openai/omni-moderation-latest", "family", true],
    ["openai/gpt-5", "default", false],
    ["meta-llama/llama-3.1-8b-instruct", "default", false],
    ["openai/gpt-4o:online", "default", false],
    ["newvendor/unheard-of", "default", false],
    ["", "default", false],
  ],
  agrees: (name, profile) => {
    const chat = profile.kind === "chat";
    const model = { provider: OPENROUTER, provider_config: { model_name: name } };

    expect(openrouterEffortPolicy(model)?.supported.length ?? 0).toBe(
      chat ? MODEL_EFFORTS.length : 0
    );
    expect("reasoning" in buildOpenRouterExtras({ ...model, effort: "high" } as never)).toBe(chat);

    const expected = openRouterProfileCapabilities(profile);
    expect(expected.includes("text.generation")).toBe(chat);
    if (name.length === 0) return;
    expect(inferOpenRouterCapabilities(record(name))).toEqual(expected);

    // A /models entry carrying no metadata is described by its profile alone.
    const [item] = mapOpenRouterModels([{ id: name }]);
    expect(item!.record.capabilities).toEqual([...expected]);
    expect((item!.record as { effort_options?: unknown[] }).effort_options?.length ?? 0).toBe(
      chat ? MODEL_EFFORTS.length : 0
    );
  },
});

describe("OpenRouter profile invariants", () => {
  it("lets /models metadata decide the capabilities when a record carries it", () => {
    const caps = inferOpenRouterCapabilities(
      record("openai/text-embedding-3-small", {
        architecture: { input_modalities: ["text"] },
        supported_parameters: ["tools"],
      })
    );
    expect(caps).toContain("text.generation");
    expect(caps).toContain("tool-use");
  });

  it("does not advertise chat for a known non-text id with no metadata", () => {
    for (const id of ["openai/text-embedding-3-small", "black-forest-labs/flux.1-schnell"]) {
      expect(inferOpenRouterCapabilities(record(id))).toEqual(["model.info", "model.search"]);
    }
  });

  it("keeps the effort dial for an id it cannot place", () => {
    expect(resolveOpenRouterProfile("newvendor/unheard-of").profile.kind).toBe("chat");
    expect(
      openrouterEffortPolicy({
        provider: OPENROUTER,
        provider_config: { model_name: "newvendor/unheard-of" },
      })?.supported
    ).toContain("high");
  });
});
