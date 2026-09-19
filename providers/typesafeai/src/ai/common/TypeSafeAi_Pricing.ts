/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

/**
 * Jev's published card: $42 per billion input tokens, which is $0.042 per
 * million — the unit every other card in this repo is quoted in.
 *
 * `output: 0` is a stated zero, not an unreported one: TypeSafe bills input
 * tokens only and gives output away, so a run's cost is its prompt. `cached` is
 * absent because there is no prompt cache to have a rate for.
 */
const JEV: ModelPricing = {
  currency: "USD",
  input: 0.042,
  output: 0,
};

/**
 * Public list pricing for TypeSafe models (USD per 1M tokens).
 *
 * The aliases are priced alongside the versioned id because an alias is what a
 * model record usually names, and it resolves to a model on this card.
 */
export const TYPESAFEAI_PRICING: Record<string, ModelPricing> = {
  jev: JEV,
  "jev-latest": JEV,
  "jev-preview": JEV,
  "jev-1.13.0": JEV,
};

/**
 * Resolve list pricing for a TypeSafe model id.
 *
 * The bare `jev` key carries future point releases: the table walk accepts a
 * dash after a key, so `jev-1.14.0` resolves this card rather than going
 * unpriced. A dot does not count as a suffix boundary, which is why the
 * versioned ids are also named outright.
 */
export function getTypeSafeAiModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(TYPESAFEAI_PRICING, modelId, ["typesafe/"]);
}
