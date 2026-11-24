/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

import { resolveMetaProfile } from "./Meta_ModelProfiles";

const MUSE_SPARK: ModelPricing = { currency: "USD", input: 1.25, output: 4.25, cached: 0.15 };
const MUSE_SPARK_CONTRIBUTOR: ModelPricing = {
  currency: "USD",
  input: 0.1,
  output: 0.2,
  cached: 0.002,
};

/**
 * Public list pricing for Meta's Muse models (USD per 1M tokens). Reasoning
 * tokens bill as output. A contributor variant is the same model at a discount
 * in exchange for Meta training on the traffic.
 */
export const META_PRICING: Record<string, ModelPricing> = {
  "muse-wonder-1.0": { currency: "USD", input: 4, output: 20, cached: 0.2 },
  // Over 200K input tokens (cached included) the long-context card applies to
  // the whole request.
  "muse-ember-1.0": {
    currency: "USD",
    input: 0.1,
    output: 0.5,
    cached: 0.004,
    usageTiers: [
      { maxInputTokens: 200_000, pricing: { input: 0.1, output: 0.5, cached: 0.004 } },
      { minInputTokens: 200_001, pricing: { input: 0.3, output: 1.5, cached: 0.012 } },
    ],
  },
  "muse-spark-1.3": MUSE_SPARK,
  "muse-spark-1.2": MUSE_SPARK,
  "muse-spark-1.1": MUSE_SPARK,
  "muse-spark-1.3-contributor": MUSE_SPARK_CONTRIBUTOR,
  "muse-spark-1.2-contributor": MUSE_SPARK_CONTRIBUTOR,
};

/**
 * Resolve list pricing for a Meta model id.
 *
 * The non-chat models (image, transcription, segmentation) resolve to nothing:
 * they bill per image, hour or frame, so without the guard the substring walk
 * could lend one a chat model's per-token card.
 */
export function getMetaModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(
    META_PRICING,
    modelId,
    ["meta/", "meta-ai/", "meta:"],
    (id) => resolveMetaProfile(id).profile.kind === "other"
  );
}
