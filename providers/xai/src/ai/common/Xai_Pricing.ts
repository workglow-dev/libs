/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

import { resolveXaiProfile } from "./Xai_ModelProfiles";

/**
 * Public list pricing for xAI Grok models (USD per 1M tokens).
 */
export const XAI_PRICING: Record<string, ModelPricing> = {
  "grok-4.6": { currency: "USD", input: 2, output: 6, cached: 0.5 },
  "grok-4.5": { currency: "USD", input: 2, output: 6, cached: 0.3 },
  "grok-4": { currency: "USD", input: 2, output: 10, cached: 0.5 },
  "grok-3": { currency: "USD", input: 3, output: 15, cached: 0.75 },
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
