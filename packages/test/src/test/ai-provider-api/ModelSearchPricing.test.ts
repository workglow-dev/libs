/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Anthropic_ModelSearch_Stream, getAnthropicModelPricing } from "@workglow/anthropic/ai";
import { DeepSeek_ModelSearch_Stream, getDeepSeekModelPricing } from "@workglow/deepseek/ai";
import { Gemini_ModelSearch_Stream, getGeminiModelPricing } from "@workglow/google-gemini/ai";
import { OpenAI_ModelSearch_Stream, getOpenAiModelPricing } from "@workglow/openai/ai";
import { Xai_ModelSearch_Stream, getXaiModelPricing } from "@workglow/xai/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

/**
 * `model add` / `model find` persist the record a search result carries, and a
 * persisted rate card is never revisited. A card copied out of the provider's
 * table at search time therefore freezes those rates into the repository: the
 * table is the maintained source and correcting a rate there would no longer
 * reach the model, with nothing on screen to say the figure is old.
 *
 * So a search result describes the model and leaves `pricing` unset. The rate
 * is resolved from the provider's table when a cost is estimated, and a card
 * that IS on a record means someone declared it deliberately.
 */
async function searchRecords(
  fn: (input: any, model: any, signal: any, emit: any) => Promise<void>
): Promise<any[]> {
  const events: any[] = [];
  await fn({ query: "" } as any, undefined as any, undefined as any, (e: any) => events.push(e));
  const results = events.at(-1)!.data.results as any[];
  expect(results.length).toBeGreaterThan(0);
  return results;
}

describe("cloud model search results", () => {
  it("leaves pricing unset on Anthropic records while the table still prices them", async () => {
    const results = await searchRecords(Anthropic_ModelSearch_Stream);
    for (const result of results) {
      expect(result.record.pricing).toBeUndefined();
      expect(getAnthropicModelPricing(result.id)).toBeDefined();
    }
  });

  it("leaves pricing unset on OpenAI records while the table still prices them", async () => {
    const results = await searchRecords(OpenAI_ModelSearch_Stream);
    for (const result of results) {
      expect(result.record.pricing).toBeUndefined();
    }
    expect(results.some((result) => getOpenAiModelPricing(result.id) !== undefined)).toBe(true);
  });

  it("leaves pricing unset on DeepSeek records while the table still prices them", async () => {
    const results = await searchRecords(DeepSeek_ModelSearch_Stream);
    for (const result of results) {
      expect(result.record.pricing).toBeUndefined();
    }
    expect(results.some((result) => getDeepSeekModelPricing(result.id) !== undefined)).toBe(true);
  });

  it("leaves pricing unset on xAI records while the table still prices them", async () => {
    const results = await searchRecords(Xai_ModelSearch_Stream);
    for (const result of results) {
      expect(result.record.pricing).toBeUndefined();
    }
    expect(results.some((result) => getXaiModelPricing(result.id) !== undefined)).toBe(true);
  });

  // Gemini maps the live /models listing through a different function than its
  // credential-free fallback list, and only the live one ever carried a card —
  // so the listing is what this has to exercise.
  it("leaves pricing unset on Gemini records from the live listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }],
        }),
        { status: 200 }
      )
    );
    const events: any[] = [];
    await Gemini_ModelSearch_Stream(
      { query: "", credential_key: "test-key" } as any,
      undefined as any,
      undefined as any,
      (e: any) => events.push(e)
    );
    const results = events.at(-1)!.data.results as any[];
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("gemini-2.5-pro");
    expect(results[0].record.pricing).toBeUndefined();
    expect(getGeminiModelPricing("gemini-2.5-pro")).toBeDefined();
  });
});

/**
 * Capabilities whose models are not billed per token.
 *
 * A card of per-1M-token rates on one of these is not an approximation, it is a
 * fabricated unit: image generation bills per image. `undefined` is the correct
 * answer for a model a token table cannot price — a sibling's card is not.
 */
const NOT_TOKEN_BILLED = new Set(["image.generation", "audio.speech", "audio.transcription"]);

/**
 * Image models the table prices deliberately because they really are billed per
 * token (a text bucket plus an image bucket), unlike DALL-E, which bills per
 * image and must stay unpriced.
 *
 * Spelled as exact ids rather than a `^gpt-image` pattern: a pattern would also
 * wave through a future GPT Image model that goes back to per-image billing,
 * which is the one case this guard exists to catch.
 */
const TOKEN_BILLED_IMAGE_MODELS = new Set([
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
]);

const PRICED_PROVIDERS = [
  { name: "Anthropic", search: Anthropic_ModelSearch_Stream, resolve: getAnthropicModelPricing },
  { name: "OpenAI", search: OpenAI_ModelSearch_Stream, resolve: getOpenAiModelPricing },
  { name: "DeepSeek", search: DeepSeek_ModelSearch_Stream, resolve: getDeepSeekModelPricing },
  { name: "xAI", search: Xai_ModelSearch_Stream, resolve: getXaiModelPricing },
] as const;

/**
 * The honesty axis the pricing primitive shipped without.
 *
 * Refusal, cache checkpoints and effort each needed a conformance assertion and
 * each got one only after a defect. This one is driven off the provider's own
 * catalogue, so the fixture cannot drift from what the provider reports.
 */
describe("a rate card must match the model's billing unit", () => {
  it.each(PRICED_PROVIDERS)(
    "$name prices no model its own catalogue calls non-token-billed",
    async ({ search, resolve }) => {
      const results = await searchRecords(search);
      const offenders = results
        .filter((result) =>
          ((result.record?.capabilities ?? []) as string[]).some((c) => NOT_TOKEN_BILLED.has(c))
        )
        .filter((result) => !TOKEN_BILLED_IMAGE_MODELS.has(result.id))
        .filter((result) => resolve(result.id) !== undefined)
        .map((result) => `${result.id} (${(result.record.capabilities as string[]).join(", ")})`);
      expect(offenders).toEqual([]);
    }
  );

  it("is not vacuous: some catalogue really does report a non-token-billed model", async () => {
    // Without this the loop above passes just as well over four catalogues that
    // contain nothing it could ever flag.
    const seen: string[] = [];
    for (const { search } of PRICED_PROVIDERS) {
      for (const result of await searchRecords(search)) {
        const capabilities = (result.record?.capabilities ?? []) as string[];
        if (capabilities.some((c) => NOT_TOKEN_BILLED.has(c))) seen.push(result.id);
      }
    }
    expect(seen).toContain("grok-2-image-1212");
  });

  it("OpenAI prices gpt-6-astra at the published short-context card", () => {
    const card = getOpenAiModelPricing("gpt-6-astra");
    expect(card).toMatchObject({
      currency: "USD",
      input: 10,
      output: 50,
      cached: 1,
      cacheWrite: 12.5,
    });
    expect(getOpenAiModelPricing("openai/gpt-6-astra")).toEqual(card);
  });

  it.each([
    ["gpt-5.6-sol", { input: 4, output: 20, cached: 0.4, cacheWrite: 5 }],
    ["gpt-5.6-terra", { input: 2, output: 12, cached: 0.2, cacheWrite: 2.5 }],
    ["gpt-5.6-luna", { input: 0.2, output: 1.2, cached: 0.02, cacheWrite: 0.25 }],
    ["gpt-5.5", { input: 5, output: 30, cached: 0.5 }],
    ["gpt-5.4", { input: 2.5, output: 15, cached: 0.25 }],
    ["gpt-5.2", { input: 1.75, output: 14, cached: 0.175 }],
    ["gpt-5", { input: 1.25, output: 10, cached: 0.125 }],
    ["gpt-5-mini", { input: 0.25, output: 2, cached: 0.025 }],
    ["gpt-5-nano", { input: 0.05, output: 0.4, cached: 0.005 }],
  ] as const)("OpenAI prices %s at the published short-context card", (id, rates) => {
    expect(getOpenAiModelPricing(id)).toMatchObject({ currency: "USD", ...rates });
  });

  it("DeepSeek prices V4.1 Flash under its canonical id and retired aliases", () => {
    // deepseek-flash is DeepSeek-V4.1-Flash. The v4-flash names are retired
    // aliases billed at the same Flash rates. Base rates are peak; off-peak
    // is half, in the two daily windows outside 01:00–04:00 and 06:00–10:00 UTC.
    const card = getDeepSeekModelPricing("deepseek-flash");
    expect(card).toMatchObject({
      currency: "USD",
      input: 0.3,
      output: 1.2,
      cached: 0.006,
    });
    expect(card?.timingTiers).toEqual([
      { start: "10:00", end: "01:00", pricing: { input: 0.15, output: 0.6, cached: 0.003 } },
      { start: "04:00", end: "06:00", pricing: { input: 0.15, output: 0.6, cached: 0.003 } },
    ]);
    expect(getDeepSeekModelPricing("deepseek-v4-flash")).toEqual(card);
    expect(getDeepSeekModelPricing("deepseek-v4-flash-0731")).toEqual(card);
  });

  it("OpenAI prices gpt-image models at the published text and image token rates", () => {
    // GPT Image is billed per token: text input $5, cached text $1.25, image
    // input $8, cached image $2, image output $30 — one published row for
    // gpt-image-2 and the 2.5 pair alike. The halved figures belong to the batch
    // row, not to gpt-image-2. DALL-E stays unpriced — it is per image.
    const card = {
      currency: "USD",
      input: 5,
      output: 30,
      cached: 1.25,
      imageInput: 8,
      imageCached: 2,
    };
    expect(getOpenAiModelPricing("gpt-image-2.5-sunburst")).toEqual(card);
    expect(getOpenAiModelPricing("gpt-image-2.5-flare")).toEqual(card);
    expect(getOpenAiModelPricing("gpt-image-2")).toEqual(card);
    expect(getOpenAiModelPricing("gpt-image-2.5-sunburst-2026-09-08")).toEqual(card);
    expect(getOpenAiModelPricing("openai/gpt-image-2.5-flare")).toEqual(card);
    expect(getOpenAiModelPricing("dall-e-3")).toBeUndefined();
  });

  it("gives each gpt-image id its own card rather than one shared object", () => {
    // The table is exported with mutable rate fields, so three keys aliasing one
    // object would let a consumer correcting one id's rate reprice the others.
    const cards = [
      getOpenAiModelPricing("gpt-image-2.5-sunburst")!,
      getOpenAiModelPricing("gpt-image-2.5-flare")!,
      getOpenAiModelPricing("gpt-image-2")!,
    ];
    expect(new Set(cards).size).toBe(cards.length);
  });

  /**
   * OpenAI publishes a cache-write rate only from GPT-5.6 on (1.25x input);
   * earlier models carry "no additional cache-write charge" and bill a write at
   * the ordinary input rate. Either way the card has to state a rate, because
   * the Responses mapper reports `cache_write_tokens` for every model and a
   * counter spent against no rate prints a partial `~` estimate.
   */
  it.each([
    ["gpt-6-astra", 10, 12.5],
    ["gpt-5.6-sol", 4, 5],
    ["gpt-5.6-terra", 2, 2.5],
    ["gpt-5.6-luna", 0.2, 0.25],
    ["gpt-5.5", 5, 5],
    ["gpt-5.4", 2.5, 2.5],
    ["gpt-5.4-mini", 0.75, 0.75],
    ["gpt-5", 1.25, 1.25],
    ["gpt-4o", 2.5, 2.5],
    ["o3", 5, 5],
  ] as const)("OpenAI prices a cache write on %s", (id, input, cacheWrite) => {
    const card = getOpenAiModelPricing(id);
    expect(card?.input).toBe(input);
    expect(card?.cacheWrite).toBe(cacheWrite);
  });

  it("declares no cache rate on an embedding card, which cannot be cached", () => {
    const card = getOpenAiModelPricing("text-embedding-3-small");
    expect(card?.cacheWrite).toBeUndefined();
    expect(card?.cached).toBeUndefined();
  });

  it("Gemini prices the image models it names and refuses the ones it does not", () => {
    // Gemini's table carries explicit image entries, so the guard must not
    // override them — only stop an unnamed image id taking a text sibling's card.
    expect(getGeminiModelPricing("gemini-3-pro-image")).toBeDefined();
    expect(getGeminiModelPricing("gemini-3.1-flash-image")).toBeDefined();
    expect(getGeminiModelPricing("imagen-4.0-generate-001")).toBeDefined();
    expect(getGeminiModelPricing("gemini-2.5-flash-image-preview")).toBeUndefined();
    expect(getGeminiModelPricing("gemini-2.5-flash")).toBeDefined();
  });

  it("refuses an unnamed image id carrying one of the prefixes it strips", () => {
    // `models/…` is the shape Gemini's ListModels returns, which is why the
    // prefix is declared at all. Gemini's image matchers are anchored, so the
    // guard has to be asked about the stripped id or a prefixed image model
    // resolves the text sibling's per-1M-token card.
    expect(getGeminiModelPricing("models/gemini-2.5-flash-image-preview")).toBeUndefined();
    expect(getGeminiModelPricing("google/gemini-2.5-flash-image-preview")).toBeUndefined();
    expect(getGeminiModelPricing("google-gemini/gemini-2.5-flash-image-preview")).toBeUndefined();
    // The prefixed text sibling still resolves; only the borrowing is blocked.
    expect(getGeminiModelPricing("models/gemini-2.5-flash")).toBeDefined();
  });
});
