/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing, ModelPricingBase, ModelUsageTier } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

/**
 * Token-count breakpoint OpenAI publishes for 1.05M-context flagships.
 * A prompt over this many input tokens reprices the whole request.
 */
const LONG_CONTEXT_TOKENS = 272_000;

type OpenAiTokenRates = {
  readonly input: number;
  readonly output: number;
  readonly cached?: number;
  /**
   * Published cache-write rate, which GPT-5.6 and later carry at 1.25x input.
   * Omitted for an earlier model, where OpenAI publishes no cache-write row
   * because there is "no additional cache-write charge" — a write bills at the
   * ordinary input rate, which {@link flagshipCard} and {@link standardCard}
   * fill in. Leaving it unset instead would price the write at nothing: the
   * Responses mapper reports `cache_write_tokens` for every model, and a
   * counter spent with no declared rate prints a partial `~` estimate on every
   * cold checkpoint call.
   */
  readonly cacheWrite?: number;
};

/** A rate set with the cache-write rule applied, ready to price against. */
interface ResolvedOpenAiRates extends OpenAiTokenRates {
  readonly cacheWrite: number;
}

function resolveRates(rates: OpenAiTokenRates): ResolvedOpenAiRates {
  return { ...rates, cacheWrite: rates.cacheWrite ?? rates.input };
}

/** A card whose rates hold for any prompt size. */
function standardCard(rates: OpenAiTokenRates): ModelPricing {
  return { currency: "USD", ...resolveRates(rates) };
}

/** Round a derived rate to the grain rates are published at. */
const perMillion = (rate: number): number => Math.round(rate * 1e6) / 1e6;

/**
 * Standard rates up to 272K, then 2x input/cache/cache-write and 1.5x output
 * above it. The lower row restates the base rates so a prompt of exactly 272K
 * stays on the short-context card: tiers resolve in declared order.
 *
 * Derived rather than transcribed because the published long row is exactly
 * those multiples on all six flagships. The products are rounded: 1.2 * 1.5 is
 * 1.7999999999999998, and gpt-5.6-luna's published long output rate is $1.80.
 */
function longContextTiers(short: ResolvedOpenAiRates): ModelUsageTier[] {
  const long: ModelPricingBase = {
    input: perMillion(short.input * 2),
    output: perMillion(short.output * 1.5),
    cacheWrite: perMillion(short.cacheWrite * 2),
    ...(short.cached !== undefined ? { cached: perMillion(short.cached * 2) } : {}),
  };
  return [
    { maxInputTokens: LONG_CONTEXT_TOKENS, pricing: short },
    { minInputTokens: LONG_CONTEXT_TOKENS, pricing: long },
  ];
}

function flagshipCard(rates: OpenAiTokenRates): ModelPricing {
  const short = resolveRates(rates);
  return { currency: "USD", ...short, usageTiers: longContextTiers(short) };
}

/**
 * GPT Image is billed per token rather than per image, over three buckets: text
 * input, image input at a higher rate, and image output. The published row is
 * the same for gpt-image-2 and the 2.5 pair.
 *
 * A factory rather than one shared constant because {@link OPENAI_PRICING} is
 * exported with mutable rate fields: three keys aliasing one object would let a
 * consumer correcting one id's rate silently reprice the other two.
 *
 * No cache rate beyond the text one is declared, and none is derived. The
 * Images API reports no cache counters at all, so `imageCached` never has a
 * figure to price on this surface.
 */
function gptImageCard(): ModelPricing {
  return { currency: "USD", input: 5, output: 30, cached: 1.25, imageInput: 8, imageCached: 2 };
}

/**
 * Public list pricing for OpenAI models (USD per 1M tokens).
 *
 * 1.05M-context flagships (Astra, GPT-5.6, GPT-5.5, GPT-5.4) carry a 272K
 * surcharge. Mini/nano and older GPT-5/4.1 cards are a single row even when
 * the window is large enough to pass that threshold.
 */
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  "gpt-6-astra": flagshipCard({ input: 10, output: 50, cached: 1, cacheWrite: 12.5 }),
  "gpt-5.6-sol": flagshipCard({ input: 4, output: 20, cached: 0.4, cacheWrite: 5 }),
  "gpt-5.6-terra": flagshipCard({ input: 2, output: 12, cached: 0.2, cacheWrite: 2.5 }),
  "gpt-5.6-luna": flagshipCard({ input: 0.2, output: 1.2, cached: 0.02, cacheWrite: 0.25 }),
  "gpt-5.5": flagshipCard({ input: 5, output: 30, cached: 0.5 }),
  "gpt-5.4-mini": standardCard({ input: 0.75, output: 4.5, cached: 0.075 }),
  "gpt-5.4-nano": standardCard({ input: 0.2, output: 1.25, cached: 0.02 }),
  "gpt-5.4": flagshipCard({ input: 2.5, output: 15, cached: 0.25 }),
  "gpt-5.2-mini": standardCard({ input: 0.15, output: 0.6, cached: 0.075 }),
  "gpt-5.2": standardCard({ input: 1.75, output: 14, cached: 0.175 }),
  "gpt-5-mini": standardCard({ input: 0.25, output: 2, cached: 0.025 }),
  "gpt-5-nano": standardCard({ input: 0.05, output: 0.4, cached: 0.005 }),
  "gpt-5": standardCard({ input: 1.25, output: 10, cached: 0.125 }),
  "gpt-4.5": standardCard({ input: 75, output: 150, cached: 37.5 }),
  "gpt-4.1": standardCard({ input: 2, output: 8, cached: 0.5 }),
  "gpt-4.1-mini": standardCard({ input: 0.4, output: 1.6, cached: 0.1 }),
  "gpt-4o": standardCard({ input: 2.5, output: 10, cached: 1.25 }),
  "gpt-4o-mini": standardCard({ input: 0.15, output: 0.6, cached: 0.075 }),
  "o3-mini": standardCard({ input: 1.1, output: 4.4, cached: 0.55 }),
  o3: standardCard({ input: 5, output: 20, cached: 2.5 }),
  o1: standardCard({ input: 15, output: 60, cached: 7.5 }),
  "o1-mini": standardCard({ input: 1.1, output: 4.4, cached: 0.55 }),
  // Embeddings are not cacheable, so these carry no cache rate at all rather
  // than the input-rate cache write every chat card gets.
  "text-embedding-3-small": { currency: "USD", input: 0.02, output: 0 },
  "text-embedding-3-large": { currency: "USD", input: 0.13, output: 0 },
  "gpt-image-2.5-sunburst": gptImageCard(),
  "gpt-image-2.5-flare": gptImageCard(),
  "gpt-image-2": gptImageCard(),
};

/**
 * Resolve list pricing for an OpenAI model id.
 */
export function getOpenAiModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(OPENAI_PRICING, modelId, ["openai/"]);
}
