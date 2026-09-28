/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

import { GEMINI_IMAGE_MODELS } from "./Gemini_EffortPolicy";

/**
 * Public list pricing for Google Gemini models (USD per 1M tokens).
 *
 * Pro models bill a prompt over 200K tokens at a higher rate, so their cards
 * carry both published rows as usage tiers. The `≤200K` tier restates the base
 * rates rather than being left implicit, which is what puts a prompt of exactly
 * 200K on the lower row: tiers resolve in declared order. Tiers restate `input`
 * and `output` only, so the card's own cache rates keep applying.
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 3.6-3.8 Flash share one introductory price through 2026-12-31. From
  // 2027-01-01 Google lists input $1.50, output $7.50, cached $0.15 and storage
  // $1.00 per 1M tokens per hour; these cards need updating then.
  "gemini-3.8-flash": {
    currency: "USD",
    input: 0.75,
    output: 3.75,
    cached: 0.075,
    cacheStoragePerHour: 0.5,
  },
  "gemini-3.7-flash": {
    currency: "USD",
    input: 0.75,
    output: 3.75,
    cached: 0.075,
    cacheStoragePerHour: 0.5,
  },
  "gemini-3.6-flash": {
    currency: "USD",
    input: 0.75,
    output: 3.75,
    cached: 0.075,
    cacheStoragePerHour: 0.5,
  },
  "gemini-3.5-flash-lite": {
    currency: "USD",
    input: 0.3,
    output: 2.5,
    cached: 0.075,
    cacheStoragePerHour: 1.0,
  },
  "gemini-3.5-flash": {
    currency: "USD",
    input: 1.5,
    output: 9,
    cached: 0.15,
    cacheStoragePerHour: 1.0,
  },
  "gemini-3.1-flash-lite": {
    currency: "USD",
    input: 0.25,
    output: 1.5,
    cached: 0.0625,
    cacheStoragePerHour: 1.0,
  },
  "gemini-3.1-pro-preview": {
    currency: "USD",
    input: 2,
    output: 12,
    cached: 0.5,
    cacheStoragePerHour: 4.5,
    usageTiers: [
      { maxInputTokens: 200_000, pricing: { input: 2, output: 12 } },
      { minInputTokens: 200_000, pricing: { input: 4, output: 18 } },
    ],
  },
  "gemini-3.1-pro": {
    currency: "USD",
    input: 2,
    output: 12,
    cached: 0.5,
    cacheStoragePerHour: 4.5,
  },
  "gemini-3-flash": {
    currency: "USD",
    input: 0.5,
    output: 3,
    cached: 0.125,
    cacheStoragePerHour: 1.0,
  },
  "gemini-2.5-flash-lite": {
    currency: "USD",
    input: 0.1,
    output: 0.4,
    cached: 0.025,
    cacheStoragePerHour: 1.0,
  },
  "gemini-2.5-flash": {
    currency: "USD",
    input: 0.3,
    output: 2.5,
    cached: 0.075,
    cacheStoragePerHour: 1.0,
  },
  "gemini-2.5-pro": {
    currency: "USD",
    input: 1.25,
    output: 10,
    cached: 0.3125,
    cacheStoragePerHour: 4.5,
    usageTiers: [
      { maxInputTokens: 200_000, pricing: { input: 1.25, output: 10 } },
      { minInputTokens: 200_000, pricing: { input: 2.5, output: 15 } },
    ],
  },
  "gemini-embedding-2": { currency: "USD", input: 0.04, output: 0 },
  "text-embedding-004": { currency: "USD", input: 0.025, output: 0 },
  "gemini-3.1-flash-image": { currency: "USD", input: 0.15, output: 0.6 },
  "gemini-3-pro-image": { currency: "USD", input: 2, output: 12 },
  "imagen-4.0-generate-001": { currency: "USD", input: 0.03, output: 0.03 },
};

/**
 * Resolve list pricing for a Google Gemini model id.
 *
 * The table prices several image models outright and those still resolve; what
 * the matcher stops is an image id the table does NOT name taking a text
 * sibling's per-token card — `gemini-2.5-flash-image-preview` was resolving
 * `gemini-2.5-flash`'s.
 */
export function getGeminiModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(
    GEMINI_PRICING,
    modelId,
    ["google-gemini/", "google/", "models/"],
    (id) => GEMINI_IMAGE_MODELS.some((pattern) => pattern.test(id))
  );
}
