/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mapOpenAIResponsesUsage } from "@workglow/ai/provider-utils";
import { describe, expect } from "vitest";

import { it } from "@workglow/test-contract/credit-exhausted-skip";

/**
 * Pins, against the live Responses API, the arithmetic
 * {@link mapOpenAIResponsesUsage} depends on: `cached_tokens` and
 * `cache_write_tokens` are breakdown lines **inside** `input_tokens`, not
 * siblings added alongside it.
 *
 * That distinction is not cosmetic. The mapper subtracts both from
 * `input_tokens` to produce the disjoint base-rate `input` bucket, so if either
 * were additive every cached call would under-report its base-rate prompt by
 * the size of the cache hit — and a cost estimate built on it would be wrong by
 * roughly the whole prompt.
 */

const RUN = !!process.env.OPENAI_API_KEY;

/** A model that reports cache **writes**, which needs 24h prompt retention. */
const CACHE_WRITE_MODEL = "gpt-5.6-luna";

interface ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly input_tokens_details: {
    readonly cached_tokens: number;
    readonly cache_write_tokens: number;
  };
}

/**
 * A prompt long enough to be cacheable — OpenAI caches only prefixes of 1024
 * tokens or more — carrying a nonce so each test run starts from a genuine
 * cache miss rather than inheriting a previous run's warm prefix.
 */
function cacheablePrompt(nonce: string): string {
  const rules = Array.from(
    { length: 400 },
    (_, i) =>
      `Rule ${i}: when the ledger balance for account ${i} exceeds the threshold, record a ` +
      `reconciliation entry citing the prior quarter's audited figure.`
  );
  return `Corpus ${nonce}.\n${rules.join("\n")}`;
}

async function respond(model: string, prompt: string, cacheKey: string): Promise<ResponsesUsage> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: prompt },
        { role: "user", content: "Reply with the single word OK." },
      ],
      max_output_tokens: 16,
      store: false,
      prompt_cache_key: cacheKey,
      prompt_cache_retention: "24h",
    }),
  });
  const body = (await response.json()) as { usage?: ResponsesUsage; error?: unknown };
  if (!response.ok || !body.usage) {
    throw new Error(`OpenAI Responses ${response.status}: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.usage;
}

/** Invariants that must hold on every response for the subtraction to be sound. */
function expectBreakdownFitsInsideInput(usage: ResponsesUsage): void {
  const { cached_tokens: cached, cache_write_tokens: written } = usage.input_tokens_details;

  // Were the cache counters siblings rather than breakdown lines, the total
  // would have to account for them separately.
  expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
  // A prompt cannot be simultaneously read from and written to cache, and
  // neither portion can exceed the prompt it is a portion of.
  expect(cached + written).toBeLessThanOrEqual(usage.input_tokens);
}

describe.skipIf(!RUN)("OpenAI Responses usage accounting (live)", () => {
  it(
    "reports cache reads and writes as portions of input_tokens, not additions to it",
    { timeout: 120_000 },
    async () => {
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const prompt = cacheablePrompt(nonce);
      const cacheKey = `workglow-usage-accounting-${nonce}`;

      const cold = await respond(CACHE_WRITE_MODEL, prompt, cacheKey);
      const warm = await respond(CACHE_WRITE_MODEL, prompt, cacheKey);

      expectBreakdownFitsInsideInput(cold);
      expectBreakdownFitsInsideInput(warm);

      // The same prompt was sent twice, so the API must state the same prompt
      // size both times. This is the load-bearing observation: the cache
      // counters move between the two calls while `input_tokens` does not, so
      // they describe how the prompt was billed rather than adding to it.
      expect(warm.input_tokens).toBe(cold.input_tokens);

      // Caching is best-effort, so a miss on the second call is not a product
      // defect and must not fail the build -- but it does mean this run proved
      // nothing about the cache counters, so say which one was silent.
      const observed = {
        write: cold.input_tokens_details.cache_write_tokens,
        read: warm.input_tokens_details.cached_tokens,
      };
      if (observed.write === 0 && observed.read === 0) {
        console.warn(
          `[usage-accounting] ${CACHE_WRITE_MODEL} reported no cache activity; ` +
            `the subset invariant was checked but no cache counter was exercised`
        );
        return;
      }

      // Whatever was written on the cold call is what the warm call reads back.
      if (observed.write > 0 && observed.read > 0) expect(observed.read).toBe(observed.write);

      // Finally, through the mapper: the disjoint buckets must reconstruct the
      // API's own prompt total exactly.
      for (const raw of [cold, warm]) {
        const usage = mapOpenAIResponsesUsage(raw);
        expect(usage).toBeDefined();
        expect(usage!.input! + usage!.cached! + usage!.cacheWrite!).toBe(raw.input_tokens);
      }
    }
  );
});
