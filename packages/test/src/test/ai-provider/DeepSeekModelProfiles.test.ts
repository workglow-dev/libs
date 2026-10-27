/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEEPSEEK_DEFAULT_REASONING_ALLOWANCE,
  DEEPSEEK_PRICING,
  DeepSeek_ModelSearch_Stream,
  deepseekEffortPolicy,
  getDeepSeekModelPricing,
  reasoningParams,
  resolveMaxTokens,
  _testOnly as deepseek,
} from "@workglow/deepseek/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  DEEPSEEK_MODEL_PROFILES,
  DEEPSEEK_UNPRICED_PROFILE_IDS,
  normalizeDeepSeekModelId,
  resolveDeepSeekProfile,
  deepSeekProfileCapabilities,
  inferDeepSeekCapabilities,
} = deepseek;

const ds = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "DEEPSEEK", provider_config: { model_name }, ...extra }) as never;

describeModelProfileContract({
  provider: "DeepSeek",
  resolve: resolveDeepSeekProfile,
  rows: DEEPSEEK_MODEL_PROFILES,
  normalize: normalizeDeepSeekModelId,
  pricing: {
    table: DEEPSEEK_PRICING,
    unpriced: DEEPSEEK_UNPRICED_PROFILE_IDS,
    price: getDeepSeekModelPricing,
  },
  spellings: (id) => [`deepseek/${id}`, `${id}-0901`, ` ${id.toUpperCase()}`],
  normalizes: [
    ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    ["deepseek-v4-pro-0813", "deepseek-v4-pro"],
    ["deepseek/deepseek-chat", "deepseek-chat"],
    ["DeepSeek-Reasoner", "deepseek-reasoner"],
  ],
  unlisted: [
    ["deepseek-v5", "family", true],
    ["deepseek-v4-max", "family", true],
    ["deepseek-flash-lite", "family", true],
    ["deepseek-r1", "family", true],
    ["deepseek-r1-0528", "family", true],
    ["deepseek-v3", "family", true],
    ["deepseek-coder", "family", true],
    ["llama-3-70b", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    expect(deepseekEffortPolicy(ds(name)).supported.length > 0).toBe(profile.reasoning);
    expect(reasoningParams(ds(name, { effort: "high" }))).toEqual(
      profile.reasoning ? { reasoning_effort: "high" } : {}
    );
    expect(resolveMaxTokens(ds(name), 1000)).toBe(
      profile.reasoning ? 1000 + DEEPSEEK_DEFAULT_REASONING_ALLOWANCE : 1000
    );

    const caps = inferDeepSeekCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(deepSeekProfileCapabilities(profile));
      expect(caps).not.toContain("vision-input");
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("DeepSeek profile invariants", () => {
  it("prices a dated snapshot as its base id", () => {
    expect(getDeepSeekModelPricing("deepseek-v4-pro-0813")).toEqual(
      getDeepSeekModelPricing("deepseek-v4-pro")
    );
    expect(getDeepSeekModelPricing("deepseek-v4-flash-0731")).toEqual(
      getDeepSeekModelPricing("deepseek-v4-flash")
    );
  });

  it("stamps each fallback model's capabilities from its profile", async () => {
    let results: readonly { id: string; record: { capabilities: readonly string[] } }[] = [];
    await DeepSeek_ModelSearch_Stream(
      { query: "" } as never,
      undefined,
      undefined as never,
      (ev) => {
        if (ev.type === "finish") results = (ev.data as { results: typeof results }).results;
      }
    );
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.record.capabilities).toEqual(
        deepSeekProfileCapabilities(resolveDeepSeekProfile(result.id).profile)
      );
    }
  });
});
