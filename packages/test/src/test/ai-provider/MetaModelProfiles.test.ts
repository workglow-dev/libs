/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getMetaModelPricing,
  getMetaReasoningEffort,
  META_PRICING,
  Meta_ModelSearch_Stream,
  metaEffortPolicy,
  _testOnly as meta,
} from "@workglow/meta/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  META_MODEL_PROFILES,
  META_UNPRICED_PROFILE_IDS,
  normalizeMetaModelId,
  resolveMetaProfile,
  metaProfileCapabilities,
  inferMetaCapabilities,
} = meta;

const muse = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "META", provider_config: { model_name }, ...extra }) as never;

describeModelProfileContract({
  provider: "Meta",
  resolve: resolveMetaProfile,
  rows: META_MODEL_PROFILES,
  normalize: normalizeMetaModelId,
  pricing: {
    table: META_PRICING,
    unpriced: META_UNPRICED_PROFILE_IDS,
    price: getMetaModelPricing,
  },
  spellings: (id) => [
    `meta/${id}`,
    `meta-ai/${id}`,
    `meta:${id}`,
    `${id}-latest`,
    ` ${id.toUpperCase()}`,
  ],
  normalizes: [
    ["meta/muse-spark-1.3", "muse-spark-1.3"],
    ["meta-ai/muse-wonder-1.0", "muse-wonder-1.0"],
    ["meta:muse-ember-1.0", "muse-ember-1.0"],
    ["Muse-Spark-1.3-Latest", "muse-spark-1.3"],
    ["muse-spark-1.3-contributor", "muse-spark-1.3-contributor"],
  ],
  unlisted: [
    ["muse-spark-1.4", "family", true],
    ["muse-spark-1.4-contributor", "family", true],
    ["muse-wonder-1.1", "family", true],
    ["muse-ember-1.1", "family", true],
    ["muse-image-1.0", "family", true],
    ["muse-voice-transcribe-1.0", "family", true],
    ["sam-3.1", "family", true],
    ["Llama-4-Maverick-17B-128E-Instruct-FP8", "default", false],
    ["grok-4", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const chat = profile.kind === "chat" ? profile : undefined;
    const reasons = chat?.reasoning === true;

    expect(metaEffortPolicy(muse(name)).supported.length > 0).toBe(reasons);
    expect(metaEffortPolicy(muse(name)).supported.includes("ultra")).toBe(chat?.maxEffort === true);
    expect(metaEffortPolicy(muse(name)).supported).not.toContain("none");
    expect(getMetaReasoningEffort(muse(name, { effort: "high" }))).toBe(
      reasons ? "high" : undefined
    );

    // The non-chat models bill per image, hour or frame: the token table prices none.
    if (profile.kind === "other") expect(getMetaModelPricing(name)).toBeUndefined();

    const caps = inferMetaCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(metaProfileCapabilities(profile));
      expect(caps.includes("text.generation")).toBe(chat !== undefined);
      expect(caps.includes("vision-input")).toBe(chat?.vision === true);
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
    }
  },
});

describe("Meta profile invariants", () => {
  it("stamps each fallback model's capabilities from its profile", async () => {
    let results: readonly { id: string; record: { capabilities: readonly string[] } }[] = [];
    await Meta_ModelSearch_Stream({ query: "" } as never, undefined, undefined as never, (ev) => {
      if (ev.type === "finish") results = (ev.data as { results: typeof results }).results;
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const { profile, recognized } = resolveMetaProfile(result.id);
      expect([result.id, recognized]).toEqual([result.id, true]);
      expect(result.record.capabilities).toEqual(metaProfileCapabilities(profile));
    }
  });

  it("prices a contributor variant at its own discounted card, not its base model's", () => {
    expect(getMetaModelPricing("muse-spark-1.3-contributor")?.input).toBe(0.1);
    expect(getMetaModelPricing("muse-spark-1.3")?.input).toBe(1.25);
  });

  it("carries Muse Ember's long-context card as a usage tier", () => {
    const tiers = getMetaModelPricing("muse-ember-1.0")?.usageTiers ?? [];
    expect(tiers.map((t) => t.pricing.input)).toEqual([0.1, 0.3]);
  });
});
