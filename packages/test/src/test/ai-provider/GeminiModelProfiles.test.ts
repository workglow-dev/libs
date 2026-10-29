/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_PRICING,
  Gemini_ModelSearch_Stream,
  geminiEffortPolicy,
  getGeminiModelPricing,
  _testOnly as gemini,
} from "@workglow/google-gemini/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  GEMINI_MODEL_PROFILES,
  GEMINI_UNPRICED_PROFILE_IDS,
  normalizeGeminiModelId,
  resolveGeminiProfile,
  geminiProfileCapabilities,
  inferGeminiCapabilities,
  geminiReturnsThoughts,
  geminiSupportsMultimodalFunctionResponses,
  resolveThinkingConfig,
} = gemini;

const model = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "GOOGLE_GEMINI", provider_config: { model_name }, ...extra }) as never;

describeModelProfileContract({
  provider: "Gemini",
  resolve: resolveGeminiProfile,
  rows: GEMINI_MODEL_PROFILES,
  normalize: normalizeGeminiModelId,
  pricing: {
    table: GEMINI_PRICING,
    unpriced: GEMINI_UNPRICED_PROFILE_IDS,
    price: getGeminiModelPricing,
  },
  spellings: (id) => [
    `models/${id}`,
    `google/${id}`,
    `google-gemini/${id}`,
    `  ${id.toUpperCase()} `,
  ],
  normalizes: [
    ["models/gemini-2.5-flash", "gemini-2.5-flash"],
    ["google/gemini-3-pro-image", "gemini-3-pro-image"],
    ["google-gemini/Gemini-3.8-Flash", "gemini-3.8-flash"],
    [" text-embedding-004 ", "text-embedding-004"],
  ],
  unlisted: [
    ["gemini-embedding-001", "family", true],
    ["text-embedding-005", "family", true],
    ["embedding-001", "family", true],
    ["imagen-3.0-generate-002", "family", true],
    ["gemini-2.5-flash-image-preview", "family", true],
    ["models/gemini-2.5-flash-image", "family", true],
    ["gemini-1.0-pro", "family", true],
    ["gemini-1.0-pro-001", "family", true],
    ["gemini-1.5-pro", "family", true],
    ["gemini-2.0-flash", "family", true],
    ["gemini-2.5-flash-preview-05-20", "family", true],
    ["gemini-3-flash-preview", "family", true],
    ["gemini-3.5-pro", "family", true],
    ["gemini-4-pro", "family", true],
    ["gemini-10-pro", "family", true],
    ["gemini-flash-latest", "family", true],
    ["gemini-1.0-pro-vision", "default", false],
    ["gemini-ultra", "default", false],
    ["palm-2", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const chat = profile.kind === "chat" ? profile : undefined;
    const thinks = chat?.thinks === true;

    expect(geminiEffortPolicy(model(name)).supported.length > 0).toBe(thinks);
    expect(geminiReturnsThoughts(name)).toBe(thinks);
    expect(geminiSupportsMultimodalFunctionResponses(name)).toBe(
      chat?.multimodalFunctionResponses === true
    );
    expect(
      resolveThinkingConfig(model(name), 100, undefined, { includeThoughts: true }).thinkingConfig
    ).toEqual(thinks ? { includeThoughts: true } : undefined);
    expect(resolveThinkingConfig(model(name, { effort: "high" }), 100).thinkingConfig).toEqual(
      thinks ? { thinkingBudget: 2048 } : undefined
    );

    // An image model bills per image: only a card the table names outright prices it.
    if (profile.kind === "image") {
      expect(getGeminiModelPricing(name) !== undefined).toBe(
        Object.hasOwn(GEMINI_PRICING, normalizeGeminiModelId(name))
      );
    }

    const caps = inferGeminiCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(geminiProfileCapabilities(profile));
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("image.generation")).toBe(profile.kind === "image");
      expect(caps.includes("image.editing")).toBe(profile.kind === "image" && profile.editing);
      expect(caps.includes("vision-input")).toBe(chat?.vision === true);
      expect(caps.includes("cache.checkpoint")).toBe(chat?.cachedContent === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("Gemini profile invariants", () => {
  it("does not hand a model from before Gemini 2.5 the thinking dial", () => {
    for (const id of ["gemini-pro", "gemini-1.0-pro", "gemini-1.5-flash", "gemini-2.0-flash"]) {
      expect([id, geminiEffortPolicy(model(id)).supported]).toEqual([id, []]);
    }
  });

  it("keeps an unpriced image model unpriced in every spelling", () => {
    for (const id of [
      "gemini-2.5-flash-image-preview",
      "models/gemini-2.5-flash-image-preview",
      "google/gemini-2.5-flash-image-preview",
    ]) {
      expect([id, getGeminiModelPricing(id)]).toEqual([id, undefined]);
    }
  });

  it("stamps each fallback model's capabilities from its profile", async () => {
    let results: readonly { id: string; record: { capabilities: readonly string[] } }[] = [];
    await Gemini_ModelSearch_Stream({ query: "" } as never, undefined, undefined as never, (ev) => {
      if (ev.type === "finish") results = (ev.data as { results: typeof results }).results;
    });
    expect(results.map((r) => r.id)).toEqual(GEMINI_FALLBACK_MODELS.map((m) => m.value));
    for (const result of results) {
      expect(result.record.capabilities).toEqual(
        geminiProfileCapabilities(resolveGeminiProfile(result.id).profile)
      );
    }
  });
});
