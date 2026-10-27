/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getTypeSafeAiModelPricing,
  inferTypeSafeAiCapabilities,
  mapTypeSafeAiModels,
  TYPESAFEAI_PRICING,
  _testOnly as typesafe,
} from "@workglow/typesafeai/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  TYPESAFEAI_MODEL_PROFILES,
  TYPESAFEAI_UNPRICED_PROFILE_IDS,
  normalizeTypeSafeAiModelId,
  resolveTypeSafeAiProfile,
  typeSafeAiProfileCapabilities,
} = typesafe;

describeModelProfileContract({
  provider: "TypeSafe",
  resolve: resolveTypeSafeAiProfile,
  rows: TYPESAFEAI_MODEL_PROFILES,
  normalize: normalizeTypeSafeAiModelId,
  pricing: {
    table: TYPESAFEAI_PRICING,
    unpriced: TYPESAFEAI_UNPRICED_PROFILE_IDS,
    price: getTypeSafeAiModelPricing,
  },
  spellings: (id) => [`typesafe/${id}`, ` ${id.toUpperCase()}`],
  normalizes: [
    ["typesafe/jev-latest", "jev-latest"],
    ["JEV-1.13.0", "jev-1.13.0"],
  ],
  unlisted: [
    ["jev-1.14.0", "family", true],
    ["jev-2", "family", true],
    ["gpt-4o", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    const caps = inferTypeSafeAiCapabilities({ model_id: name } as never);
    if (recognized) {
      expect(caps).toEqual(typeSafeAiProfileCapabilities(profile));
      expect(caps).not.toContain("text.generation");
      expect(mapTypeSafeAiModels([{ label: name, value: name }])[0]!.record.capabilities).toEqual(
        caps
      );
    } else {
      expect(caps).toEqual(["model.search", "model.info"]);
      expect(mapTypeSafeAiModels([{ label: name, value: name }])[0]!.record.capabilities).toEqual(
        []
      );
    }
  },
});

describe("TypeSafe profile invariants", () => {
  it("prices a future jev release on Jev's card", () => {
    expect(getTypeSafeAiModelPricing("jev-1.14.0")).toEqual(getTypeSafeAiModelPricing("jev"));
  });
});
