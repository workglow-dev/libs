/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing, ModelRecord } from "@workglow/ai";
import {
  FREE_LOCAL_PRICING,
  getAiProviderRegistry,
  getGlobalModelRepository,
  mergeModelPricing,
} from "@workglow/ai";
import { getAnthropicModelPricing } from "@workglow/anthropic/ai";
import { getDeepSeekModelPricing } from "@workglow/deepseek/ai";
import { getGeminiModelPricing } from "@workglow/google-gemini/ai";
import { getMetaModelPricing } from "@workglow/meta/ai";
import { getOpenAiModelPricing } from "@workglow/openai/ai";
import { getXaiModelPricing } from "@workglow/xai/ai";

/**
 * Providers whose own list table is one of the six consulted below.
 *
 * The chain reads an id's SHAPE, which only means something for a record that
 * belongs to one of these vendors — or for a bare id, where the shape is all
 * there is. An aggregator carries vendor-shaped ids it is not billed at, so a
 * record naming anything else must not reach the chain.
 */
const VENDOR_TABLE_PROVIDERS: ReadonlySet<string> = new Set([
  "ANTHROPIC",
  "OPENAI",
  "GOOGLE_GEMINI",
  "XAI",
  "DEEPSEEK",
  "META",
]);

const cache = new Map<string, ModelPricing | undefined>();
const inflight = new Map<string, Promise<ModelPricing | undefined>>();

/**
 * Published rate card for a model id, under whatever the record declares.
 *
 * A record names its provider, so that provider answers for it — including when
 * the answer is "I have no card". Declining is an assertion, not a referral: the
 * vendor chain below strips exactly the prefixes an OpenRouter id carries, so
 * `openai/gpt-4o` would resolve OpenAI's own list rates for a route billed by
 * OpenRouter at whichever upstream it chose. A number that is wrong reads as a
 * cost; `undefined` reads as unpriced, which is true.
 *
 * A bare id does NOT get offered to every registered provider in turn: a local
 * provider answers `FREE_LOCAL_PRICING` for anything it is asked about, so the
 * first one registered (the CLI always registers HuggingFace Transformers at
 * startup) would price every cloud model at zero. Without a record the id's own
 * shape is the only honest signal — local prefixes, then each cloud vendor's
 * list table.
 */
function resolveFallbackPricing(modelId: string, record?: ModelRecord): ModelPricing | undefined {
  if (record?.provider) {
    // The named provider answers, and its silence is an answer: declining is
    // "I have no card", not "ask someone else".
    const provider = getAiProviderRegistry().getProvider(record.provider);
    if (provider) return provider.modelPricing(record);
  }
  if (modelId.startsWith("gguf:") || modelId.startsWith("onnx:") || modelId.endsWith(".gguf")) {
    return FREE_LOCAL_PRICING;
  }
  // Reached when the record names no provider, or names one whose class is not
  // registered here. Either way the chain may only answer for a vendor the
  // record could plausibly be billed by — `openai/gpt-4o` on an OPENROUTER
  // record is OpenAI's id, at rates OpenRouter never charged.
  if (record?.provider !== undefined && !VENDOR_TABLE_PROVIDERS.has(record.provider)) {
    return undefined;
  }
  return (
    getAnthropicModelPricing(modelId) ??
    getOpenAiModelPricing(modelId) ??
    getGeminiModelPricing(modelId) ??
    getXaiModelPricing(modelId) ??
    getDeepSeekModelPricing(modelId) ??
    getMetaModelPricing(modelId)
  );
}

/**
 * Resolve a model's effective rate card: the one its repository record declares,
 * merged field by field over the provider's published card.
 *
 * Memoized per model id for the process lifetime — rate cards do not change
 * mid-run, and the CLI re-reads usage on every snapshot, so an uncached lookup
 * would re-hit storage once per stream event.
 */
export async function lookupModelPricing(
  modelId: string | undefined
): Promise<ModelPricing | undefined> {
  if (!modelId) return undefined;
  if (cache.has(modelId)) return cache.get(modelId);

  let pending = inflight.get(modelId);
  if (!pending) {
    pending = getGlobalModelRepository()
      .findByName(modelId)
      .then((record) => {
        const pricing = mergeModelPricing(record?.pricing, resolveFallbackPricing(modelId, record));
        cache.set(modelId, pricing);
        inflight.delete(modelId);
        return pricing;
      })
      .catch(() => {
        const pricing = resolveFallbackPricing(modelId);
        cache.set(modelId, pricing);
        inflight.delete(modelId);
        return pricing;
      });
    inflight.set(modelId, pending);
  }
  return pending;
}

/** Test-only: drop the memo so a suite can re-register models with new rates. */
export function clearModelPricingCache(): void {
  cache.clear();
  inflight.clear();
}
