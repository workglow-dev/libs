/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ANTHROPIC_PRICING,
  Anthropic_ModelSearch_Stream,
  anthropicEffortPolicy,
  getAnthropicModelPricing,
  _testOnly as anthropic,
} from "@workglow/anthropic/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  ANTHROPIC_MODEL_PROFILES,
  ANTHROPIC_UNPRICED_PROFILE_IDS,
  normalizeAnthropicModelId,
  resolveAnthropicProfile,
  anthropicProfileCapabilities,
  inferAnthropicCapabilities,
  resolveAnthropicOutputFormatSupport,
  resolveAnthropicForcedToolChoice,
  anthropicAcceptsSamplingParams,
  anthropicSupportsAdaptiveThinking,
  anthropicMinimalThinkingParams,
  anthropicDefaultThinkingParams,
} = anthropic;

const claude = (model_name: string) =>
  ({ provider: "ANTHROPIC", provider_config: { model_name } }) as never;

describeModelProfileContract({
  provider: "Anthropic",
  resolve: resolveAnthropicProfile,
  rows: ANTHROPIC_MODEL_PROFILES,
  normalize: normalizeAnthropicModelId,
  pricing: {
    table: ANTHROPIC_PRICING,
    unpriced: ANTHROPIC_UNPRICED_PROFILE_IDS,
    price: getAnthropicModelPricing,
  },
  spellings: (id) => [
    `anthropic/${id}`,
    `us.anthropic.${id}-v1:0`,
    `${id}@20251001`,
    `${id}-20251001`,
    `${id}[1m]`,
    `  ${id.toUpperCase()} `,
  ],
  normalizes: [
    ["anthropic/claude-opus-4.5", "claude-opus-4-5"],
    ["anthropic/claude-3.5-sonnet", "claude-3-5-sonnet"],
    ["anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5"],
    ["eu.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet"],
    ["claude-sonnet-4-5@20250929", "claude-sonnet-4-5"],
    ["claude-opus-4-1@latest", "claude-opus-4-1"],
    ["  Claude-Haiku-4-5-20251001 ", "claude-haiku-4-5"],
    ["claude-opus-4-8[1m]", "claude-opus-4-8"],
    ["claude-2.1", "claude-2.1"],
    ["claude-instant-1.2", "claude-instant-1.2"],
  ],
  unlisted: [
    ["claude-opus-6", "default", true],
    ["claude-fable-6", "default", true],
    ["claude-mythos-6-1", "default", true],
    ["claude-opus-5-3", "default", true],
    ["claude-nova-5", "default", false],
    ["claude-sonnet-4-9", "default", true],
    ["claude-sonnet-4-20250514", "default", true],
    ["claude-3-sonnet-20240229", "default", true],
    ["claude-2.1", "default", true],
    ["mystery", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const model = claude(name);
    expect(resolveAnthropicOutputFormatSupport(model).value).toBe(profile.supportsOutputFormat);
    expect(resolveAnthropicForcedToolChoice(model).value).toBe(profile.acceptsForcedToolChoice);
    expect(anthropicAcceptsSamplingParams(model)).toBe(profile.acceptsSamplingParams);
    expect(anthropicSupportsAdaptiveThinking(model)).toBe(profile.thinking === "adaptive");
    expect(anthropicEffortPolicy(model).supported.length === 0).toBe(profile.thinking === "none");

    const thinksWhenOmitted = profile.minimalThinking !== "omit";
    expect(anthropicDefaultThinkingParams(model) !== undefined).toBe(thinksWhenOmitted);
    expect(anthropicMinimalThinkingParams(model)).toEqual(
      profile.minimalThinking === "between_tools"
        ? { thinking: { type: "between_tools" } }
        : profile.minimalThinking === "low_effort"
          ? { output_config: { effort: "low" } }
          : undefined
    );

    const caps = inferAnthropicCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(anthropicProfileCapabilities(profile));
      expect(caps.includes("vision-input")).toBe(profile.vision);
      expect(caps.includes("cache.checkpoint")).toBe(profile.promptCaching);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("Anthropic profile invariants", () => {
  it.each(Object.entries(ANTHROPIC_MODEL_PROFILES))(
    "%s: a model that thinks when thinking is omitted thinks adaptively",
    (_id, profile) => {
      if (profile.minimalThinking !== "omit") expect(profile.thinking).toBe("adaptive");
    }
  );

  it("grades a future generation of a known family as the newest known one", () => {
    expect(resolveAnthropicProfile("claude-fable-6").profile).toBe(
      ANTHROPIC_MODEL_PROFILES["claude-fable-5-1"]
    );
  });

  it("serves neither vision nor prompt caching to Claude 2", () => {
    const caps = inferAnthropicCapabilities({ model_id: "claude-2.1" } as never);
    expect(caps).not.toContain("vision-input");
    expect(caps).not.toContain("cache.checkpoint");
  });

  it("keeps what an unrecognized record declared", () => {
    expect(
      inferAnthropicCapabilities({
        model_id: "mystery",
        capabilities: ["text.generation"],
      } as never)
    ).toEqual(["text.generation"]);
  });

  it("prices OpenRouter's dotted spelling of a priced model", () => {
    expect(getAnthropicModelPricing("anthropic/claude-3.5-sonnet")).toBe(
      ANTHROPIC_PRICING["claude-3-5-sonnet"]
    );
  });

  it("stamps each listed model with what its profile serves", async () => {
    let results: readonly { id: string; record: { capabilities: readonly string[] } }[] = [];
    await Anthropic_ModelSearch_Stream(
      { query: "" } as never,
      undefined,
      new AbortController().signal,
      (event: { type: string; data?: unknown }) => {
        if (event.type === "finish") {
          results = (event.data as { results: typeof results }).results;
        }
      }
    );
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect([result.id, result.record.capabilities]).toEqual([
        result.id,
        anthropicProfileCapabilities(resolveAnthropicProfile(result.id).profile),
      ]);
    }
  });
});
