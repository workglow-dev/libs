/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing, ModelPricingBase } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

import { resolveXaiProfile } from "./Xai_ModelProfiles";

/** Prompts of this many tokens or more bill every token of the request at the long rates. */
const LONG_CONTEXT_TOKENS = 200_000;

/**
 * A card whose rates double, cache reads included, once the prompt reaches
 * {@link LONG_CONTEXT_TOKENS}, as xAI publishes for every current Grok 4 model.
 * The short row restates the base rates so the tier boundary sits exactly where
 * xAI draws it: 199,999 tokens is short, 200,000 is long.
 */
function longContextCard(
  short: Required<Pick<ModelPricingBase, "input" | "output" | "cached">>
): ModelPricing {
  return {
    currency: "USD",
    ...short,
    usageTiers: [
      { maxInputTokens: LONG_CONTEXT_TOKENS - 1, pricing: { ...short } },
      {
        minInputTokens: LONG_CONTEXT_TOKENS,
        pricing: { input: short.input * 2, output: short.output * 2, cached: short.cached * 2 },
      },
    ],
  };
}

/** Grok 4.3's rates, which the retired ids are also billed at. */
const grok43Card = (): ModelPricing => longContextCard({ input: 1.25, output: 2.5, cached: 0.2 });

/**
 * Public list pricing for xAI Grok models (USD per 1M tokens).
 *
 * `grok-4` and `grok-3` were retired on 2026-05-15, but a request naming either
 * still succeeds: xAI redirects it to `grok-4.3` and bills it at that model's
 * rates, so that is the card they carry.
 */
export const XAI_PRICING: Record<string, ModelPricing> = {
  "grok-4.7": longContextCard({ input: 2, output: 6, cached: 0.5 }),
  "grok-4.6": longContextCard({ input: 2, output: 6, cached: 0.5 }),
  "grok-4.5": longContextCard({ input: 2, output: 6, cached: 0.3 }),
  "grok-4.3": grok43Card(),
  "grok-4": grok43Card(),
  "grok-3": grok43Card(),
  "grok-3-mini": { currency: "USD", input: 0.3, output: 1.5, cached: 0.075 },
  "grok-2": { currency: "USD", input: 2, output: 10, cached: 0.5 },
  "grok-2-vision": { currency: "USD", input: 2, output: 10, cached: 0.5 },
};

/**
 * Resolve list pricing for an xAI Grok model id.
 *
 * Image models resolve to nothing: they bill per image, and the table names
 * only the text ids, so without the guard `grok-2-image-1212` would take
 * `grok-2`'s per-1M-token card. Which ids those are is the profile's `kind`,
 * the same answer capability inference and the effort policy read.
 */
export function getXaiModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(
    XAI_PRICING,
    modelId,
    ["xai/"],
    (id) => resolveXaiProfile(id).profile.kind === "image"
  );
}
