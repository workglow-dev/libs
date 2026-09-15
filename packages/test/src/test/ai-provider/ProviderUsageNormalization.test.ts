/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mapOpenAIChatUsage, mapOpenAIResponsesUsage } from "@workglow/ai/provider-utils";
import { _testOnly as anthropicTestOnly } from "@workglow/anthropic/ai";
import { _testOnly as deepseekTestOnly } from "@workglow/deepseek/ai";
import { _testOnly as geminiTestOnly } from "@workglow/google-gemini/ai";
import { _testOnly as ollamaTestOnly } from "@workglow/ollama/ai";
import { _testOnly as openrouterTestOnly } from "@workglow/openrouter/ai";
import { describe, expect, it } from "vitest";

import { usageNormalizationBlock } from "@workglow/test-contract/ai-provider";

const { createAnthropicUsageCollector } = anthropicTestOnly;
const { mapDeepSeekUsage } = deepseekTestOnly;
const { mapGeminiUsage } = geminiTestOnly;
const { mapOllamaUsage } = ollamaTestOnly;
const { mapOpenRouterUsage } = openrouterTestOnly;

/**
 * Holds every provider's usage mapper to one normalization contract. The rule
 * that matters is the zero-vs-absent one: a counter the provider never reported
 * must come back `undefined`, because a `0` there would read as "billed nothing"
 * and understate spend.
 *
 * Anthropic maps a two-frame event stream rather than one payload, so it is
 * adapted to the same `(raw) => Usage | undefined` signature here.
 */
function mapAnthropicUsage(raw: unknown): ReturnType<typeof mapOpenAIChatUsage> {
  const collector = createAnthropicUsageCollector();
  collector.observe({ type: "message_delta", usage: raw });
  return collector.result();
}

usageNormalizationBlock({
  provider: "OpenAI (chat-completions shape)",
  mapUsage: mapOpenAIChatUsage,
  sparseFrame: { prompt_tokens: 40, completion_tokens: 11 },
  sparseReports: ["input", "output"],
  zeroFrame: { prompt_tokens: 0, completion_tokens: 0 },
  cases: [
    {
      name: "a fully-detailed completion",
      frame: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
      expected: {
        input: 40,
        output: 25,
        cached: 60,
        cacheWrite: undefined,
        reasoning: 10,
        total: 125,
        extra: undefined,
      },
    },
    {
      name: "null detail objects without inventing zeros",
      frame: {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      },
      expected: {
        input: 5,
        output: 1,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
        extra: undefined,
      },
    },
  ],
});

usageNormalizationBlock({
  provider: "OpenAI (Responses shape)",
  mapUsage: mapOpenAIResponsesUsage,
  sparseFrame: { input_tokens: 12, output_tokens: 4 },
  sparseReports: ["input", "output"],
  zeroFrame: { input_tokens: 0, output_tokens: 0 },
  cases: [
    {
      name: "cache reads and writes from input_tokens_details",
      frame: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250,
        input_tokens_details: { cached_tokens: 128, cache_write_tokens: 32 },
        output_tokens_details: { reasoning_tokens: 18 },
      },
      expected: {
        input: 40,
        output: 50,
        cached: 128,
        cacheWrite: 32,
        reasoning: 18,
        total: 250,
        extra: undefined,
      },
    },
  ],
});

usageNormalizationBlock({
  provider: "Anthropic",
  mapUsage: mapAnthropicUsage,
  sparseFrame: { input_tokens: 30, output_tokens: 9 },
  sparseReports: ["input", "output"],
  zeroFrame: { input_tokens: 0, output_tokens: 0 },
  cases: [
    {
      name: "cache reads as cached and cache creation as cacheWrite",
      frame: {
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 64,
        cache_creation_input_tokens: 16,
      },
      expected: {
        input: 80,
        output: 20,
        cached: 64,
        cacheWrite: 16,
        reasoning: undefined,
        // Anthropic states no total; synthesizing one would misreport
        // cache-discounted input as if it were billed in full.
        total: undefined,
        extra: undefined,
      },
    },
    {
      name: "null cache fields as unreported rather than zero",
      frame: {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      expected: {
        input: 12,
        output: 3,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
        extra: undefined,
      },
    },
  ],
});

usageNormalizationBlock({
  provider: "Gemini",
  mapUsage: mapGeminiUsage,
  sparseFrame: { promptTokenCount: 22, candidatesTokenCount: 6 },
  sparseReports: ["input", "output"],
  zeroFrame: { promptTokenCount: 0, candidatesTokenCount: 0 },
  cases: [
    {
      name: "cached content and thoughts token counts",
      frame: {
        promptTokenCount: 500,
        candidatesTokenCount: 120,
        cachedContentTokenCount: 400,
        thoughtsTokenCount: 45,
        totalTokenCount: 665,
      },
      expected: {
        input: 100,
        output: 165,
        cached: 400,
        cacheWrite: undefined,
        reasoning: 45,
        total: 665,
        extra: undefined,
      },
    },
  ],
});

usageNormalizationBlock({
  provider: "Ollama",
  mapUsage: mapOllamaUsage,
  sparseFrame: { done: true, prompt_eval_count: 18, eval_count: 7 },
  sparseReports: ["input", "output"],
  zeroFrame: { done: true, prompt_eval_count: 0, eval_count: 0 },
  cases: [
    {
      name: "the terminal done chunk's prompt/eval counts",
      frame: { done: true, prompt_eval_count: 64, eval_count: 12, total_duration: 1234 },
      expected: {
        input: 64,
        output: 12,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
        extra: undefined,
      },
    },
    {
      name: "an intermediate (not done) chunk as no usage at all",
      frame: { done: false, message: { content: "hi" } },
      expected: undefined,
    },
  ],
});

usageNormalizationBlock({
  provider: "DeepSeek",
  mapUsage: mapDeepSeekUsage,
  sparseFrame: { prompt_tokens: 15, completion_tokens: 5 },
  sparseReports: ["input", "output"],
  zeroFrame: { prompt_tokens: 0, completion_tokens: 0 },
  cases: [
    {
      name: "the cache hit/miss split, misses as input and hits as cached",
      frame: {
        prompt_tokens: 90,
        completion_tokens: 30,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 20,
      },
      expected: {
        input: 20,
        output: 30,
        cached: 70,
        cacheWrite: undefined,
        reasoning: undefined,
        total: 120,
        extra: undefined,
      },
    },
  ],
});

usageNormalizationBlock({
  provider: "OpenRouter",
  mapUsage: mapOpenRouterUsage,
  sparseFrame: { prompt_tokens: 8, completion_tokens: 2 },
  sparseReports: ["input", "output"],
  zeroFrame: { prompt_tokens: 0, completion_tokens: 0 },
  cases: [
    {
      name: "credits charged into extra.cost",
      frame: { prompt_tokens: 45, completion_tokens: 15, total_tokens: 60, cost: 0.00042 },
      expected: {
        input: 45,
        output: 15,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: 60,
        extra: { cost: 0.00042 },
      },
    },
  ],
});

describe("usage normalization rejects non-numeric wire values", () => {
  // A gateway that stringifies its counters must not smuggle a string into a
  // field the cost math will later add up.
  it("drops string and NaN counters rather than coercing them", () => {
    const usage = mapOpenAIChatUsage({
      prompt_tokens: "120",
      completion_tokens: Number.NaN,
      total_tokens: 130,
    });
    expect(usage).toEqual({
      input: undefined,
      output: undefined,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: 130,
      extra: undefined,
    });
  });
});
