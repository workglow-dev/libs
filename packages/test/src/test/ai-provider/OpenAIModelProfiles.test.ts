/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getOpenAiModelPricing,
  OPENAI_PRICING,
  openaiEffortPolicy,
  _testOnly as openai,
} from "@workglow/openai/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  OPENAI_MODEL_PROFILES,
  OPENAI_UNPRICED_PROFILE_IDS,
  normalizeOpenAiModelId,
  resolveOpenAiProfile,
  openAiProfileCapabilities,
  inferOpenAiCapabilities,
  resolveOpenAiTemperatureWithReasoning,
} = openai;

const gpt = (model_name: string) =>
  ({ provider: "OPENAI", provider_config: { model_name } }) as never;

describeModelProfileContract({
  provider: "OpenAI",
  resolve: resolveOpenAiProfile,
  rows: OPENAI_MODEL_PROFILES,
  normalize: normalizeOpenAiModelId,
  pricing: {
    table: OPENAI_PRICING,
    unpriced: OPENAI_UNPRICED_PROFILE_IDS,
    price: getOpenAiModelPricing,
  },
  spellings: (id) => [`openai/${id}`, `${id}-2026-01-01`, ` ${id.toUpperCase()}`],
  normalizes: [
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
    ["GPT-4o-2024-08-06", "gpt-4o"],
    ["openai/gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
  ],
  unlisted: [
    ["gpt-6-nova", "family", true],
    ["gpt-5.6-mini", "family", true],
    ["o4-mini", "family", true],
    ["gpt-4-turbo", "family", true],
    ["gpt-3.5-turbo", "family", true],
    ["gpt-7-nova", "family", true],
    ["dall-e-2", "family", true],
    ["dall-e-3", "family", true],
    ["gpt-image-3", "family", true],
    ["text-embedding-ada-002", "family", true],
    ["chatgpt-4o-latest", "default", false],
    ["mystery", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const model = gpt(name);
    const effort = openaiEffortPolicy(model).supported;
    const chat = profile.kind === "chat" ? profile : undefined;
    expect(effort.length > 0).toBe(chat !== undefined && chat.reasoning !== "none");
    expect(effort.includes("none")).toBe(chat?.reasoning === "optional");
    expect(resolveOpenAiTemperatureWithReasoning(model).value).toBe(
      chat?.acceptsTemperatureWithReasoning ?? false
    );

    const caps = inferOpenAiCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(openAiProfileCapabilities(profile));
      expect(caps.includes("text.embedding")).toBe(profile.kind === "embedding");
      expect(caps.includes("image.generation")).toBe(profile.kind === "image");
      expect(caps.includes("image.editing")).toBe(
        profile.kind === "image" && profile.editing !== "none"
      );
      expect(caps.includes("vision-input")).toBe(chat?.vision === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("OpenAI profile invariants", () => {
  it("serves no image input to the small o-series models", () => {
    for (const id of ["o1-mini", "o3-mini"]) {
      expect(inferOpenAiCapabilities({ model_id: id } as never)).not.toContain("vision-input");
    }
  });

  it("lets DALL-E 2 edit one image and DALL-E 3 none", () => {
    expect(resolveOpenAiProfile("dall-e-2").profile).toMatchObject({ editing: "single" });
    expect(resolveOpenAiProfile("dall-e-3").profile).toMatchObject({ editing: "none" });
  });

  it("reads the reasoning dial through the gateway spelling", () => {
    expect(openaiEffortPolicy(gpt("openai/gpt-5.5")).supported).toContain("medium");
  });
});
