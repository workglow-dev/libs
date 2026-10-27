/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getXaiModelPricing,
  getXaiReasoningEffort,
  XAI_PRICING,
  Xai_ModelSearch_Stream,
  xaiEffortPolicy,
  _testOnly as xai,
} from "@workglow/xai/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  XAI_MODEL_PROFILES,
  XAI_UNPRICED_PROFILE_IDS,
  normalizeXaiModelId,
  resolveXaiProfile,
  xaiProfileCapabilities,
  inferXaiCapabilities,
} = xai;

const grok = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "XAI", provider_config: { model_name }, ...extra }) as never;

describeModelProfileContract({
  provider: "xAI",
  resolve: resolveXaiProfile,
  rows: XAI_MODEL_PROFILES,
  normalize: normalizeXaiModelId,
  pricing: {
    table: XAI_PRICING,
    unpriced: XAI_UNPRICED_PROFILE_IDS,
    price: getXaiModelPricing,
  },
  spellings: (id) => [
    `xai/${id}`,
    `x-ai/${id}`,
    `${id}-1212`,
    `${id}-latest`,
    ` ${id.toUpperCase()}`,
  ],
  normalizes: [
    ["xai/grok-4", "grok-4"],
    ["x-ai/grok-4.5", "grok-4.5"],
    ["grok-2-vision-1212", "grok-2-vision"],
    ["grok-2-image-1212", "grok-2-image"],
    ["Grok-4-Latest", "grok-4"],
  ],
  unlisted: [
    ["grok-2-image-1212", "family", true],
    ["xai/grok-2-image", "family", true],
    ["grok-4-fast-non-reasoning", "family", true],
    ["grok-3-fast-non-reasoning", "family", true],
    ["grok-4-fast-reasoning", "family", true],
    ["grok-4-1-fast", "family", true],
    ["grok-3-fast", "family", true],
    ["grok-3-mini-fast", "family", true],
    ["grok-beta", "family", true],
    ["grok-vision-beta", "family", true],
    ["llama-3-70b", "default", false],
    ["reimagine-1", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const chat = profile.kind === "chat" ? profile : undefined;
    const reasons = chat?.reasoning === true;

    expect(xaiEffortPolicy(grok(name)).supported.length > 0).toBe(reasons);
    expect(getXaiReasoningEffort(grok(name, { effort: "high" }))).toBe(
      reasons ? "high" : undefined
    );

    // An image model bills per image: the token table prices none of them.
    if (profile.kind === "image") expect(getXaiModelPricing(name)).toBeUndefined();

    const caps = inferXaiCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(xaiProfileCapabilities(profile));
      expect(caps.includes("image.generation")).toBe(profile.kind === "image");
      expect(caps.includes("text.generation")).toBe(chat !== undefined);
      expect(caps.includes("vision-input")).toBe(chat?.vision === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("xAI profile invariants", () => {
  it("stamps each fallback model's capabilities from its profile", async () => {
    let results: readonly { id: string; record: { capabilities: readonly string[] } }[] = [];
    await Xai_ModelSearch_Stream({ query: "" } as never, undefined, undefined as never, (ev) => {
      if (ev.type === "finish") results = (ev.data as { results: typeof results }).results;
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const { profile, recognized } = resolveXaiProfile(result.id);
      expect([result.id, recognized]).toEqual([result.id, true]);
      expect(result.record.capabilities).toEqual(xaiProfileCapabilities(profile));
    }
    expect(results.find((r) => r.id === "grok-2-image-1212")?.record.capabilities).toContain(
      "image.generation"
    );
  });
});
