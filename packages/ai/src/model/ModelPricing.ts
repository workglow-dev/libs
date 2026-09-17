/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchemaObject } from "@workglow/util/worker";

/**
 * Per-million-token rates for one model.
 *
 * Rates are in USD per 1,000,000 tokens because that is how providers publish
 * them, so a rate card transcribes without arithmetic.
 *
 * `cacheStoragePerHour` prices a provider-side cache billed by token-hours
 * (e.g. Gemini CachedContent) rather than by a one-off write.
 *
 * Every rate is optional and an unset one means "not declared here", never
 * zero: it is what a merge fills in from a wider card, and what leaves a spent
 * counter reported as unpriced when nothing declares it.
 */
export interface ModelPricingBase {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?:
    | number
    | {
        cacheWrite5m?: number;
        cacheWrite1h?: number;
      };
  /** USD per 1M uncached image-input tokens. */
  imageInput?: number;
  /** USD per 1M cached image-input tokens. */
  imageCached?: number;
  cacheStoragePerHour?: number;
}

/**
 * A rate card that replaces the base one when the prompt falls in a token
 * range, which is how long-context surcharges are published (Anthropic and
 * Gemini both price prompts over 200K tokens differently).
 *
 * Both bounds are inclusive and either may be omitted for an open end. The
 * first tier whose range contains the prompt wins, so tiers are declared in
 * published order and an overlap at the boundary resolves to the earlier one.
 */
export interface ModelUsageTier {
  minInputTokens?: number;
  maxInputTokens?: number;
  pricing: ModelPricingBase;
}

/**
 * A rate card that replaces the base one inside a daily clock window, which is
 * how time-of-day discounts are published (DeepSeek's runs 16:30-00:30 UTC).
 *
 * `start` and `end` are `HH:MM` in **UTC** — providers publish these windows in
 * UTC and a local-time reading would silently misprice by the host's offset.
 * The window is `[start, end)`, and an `end` at or before `start` wraps
 * midnight. The first matching tier wins.
 */
export interface ModelTimingTier {
  /** Inclusive start of the window, `HH:MM` UTC. */
  start: string;
  /** Exclusive end of the window, `HH:MM` UTC. */
  end: string;
  pricing: ModelPricingBase;
}

/**
 * One model's rate card.
 *
 * A card stored on a model record is a **per-field** override of the provider's
 * published card, not a replacement for it: {@link mergeModelPricing} fills
 * every rate the record leaves unset from the provider's, so entering a single
 * negotiated `input` rate does not leave `output` and the cache rates reading as
 * unpriced. The two exceptions are stated with that function.
 */
export interface ModelPricing extends ModelPricingBase {
  currency: string;
  batch?: ModelPricingBase;
  usageTiers?: ModelUsageTier[];
  timingTiers?: ModelTimingTier[];
}

export const FREE_LOCAL_PRICING: ModelPricing = {
  currency: "USD",
  input: 0,
  output: 0,
  cached: 0,
  cacheWrite: 0,
  imageInput: 0,
  imageCached: 0,
  cacheStoragePerHour: undefined,
};

/**
 * Characters that may precede a table key inside a longer model id: vendor
 * namespaces (`anthropic.claude-…`, `bedrock/claude-…`) and separators.
 */
const KEY_PREFIX_BOUNDARY = new Set(["-", "_", ":", "/", "@", ".", "|"]);

/**
 * Characters that may follow a table key inside a longer model id. `.` is
 * deliberately absent: a dot after a key marks a different point release with
 * its own rate card (`gpt-5.6` is not `gpt-5`), while a dash marks a dated or
 * sized variant of the same one (`gpt-4o-2024-08-06` is `gpt-4o`).
 */
const KEY_SUFFIX_BOUNDARY = new Set(["-", "_", ":", "/", "@"]);

/**
 * Resolve a model id against a provider's static list-pricing table.
 *
 * Exact id wins; otherwise the longest key that appears in the id on both a
 * leading and trailing segment boundary wins. A model the table does not name
 * stays unpriced so cost estimation reports nothing rather than a wrong
 * number borrowed from a sibling.
 *
 * `vendorPrefixes` are stripped (lower-cased, longest first is the caller's
 * responsibility) before matching, so `anthropic/claude-sonnet-5` resolves the
 * same as the bare id.
 *
 * `notTokenBilled` is how a provider says an id is not billed per token at all.
 * The substring walk cannot know that: a dash is a legal suffix boundary — it
 * marks a dated or sized variant of the same model — so `grok-2-image-1212`
 * matches `grok-2` and would resolve its per-1M-token card. For a model billed
 * per image or per second of audio that is not an approximation, it is a
 * fabricated unit, and `undefined` is the honest answer. It is consulted only
 * after the exact lookups, so a table that deliberately prices an image model
 * still wins. Providers should pass the SAME matcher their effort policy uses
 * rather than a second copy of it — which is why it is asked about the same
 * prefix-stripped, lower-cased id the walk matches, so a matcher anchored at
 * `^` fires on `models/…` and `google/…` as it does on the bare id.
 */
export function resolveModelPricingFromTable(
  table: Readonly<Record<string, ModelPricing>>,
  modelId: string | undefined,
  vendorPrefixes: readonly string[] = [],
  notTokenBilled?: (modelId: string) => boolean
): ModelPricing | undefined {
  if (!modelId) return undefined;
  let id = modelId.trim().toLowerCase();
  for (const prefix of vendorPrefixes) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }

  // `Object.hasOwn`, not truthiness: a bare index would hand back
  // `Object.prototype.constructor` for a model literally named "constructor".
  if (Object.hasOwn(table, modelId)) return table[modelId];
  if (Object.hasOwn(table, id)) return table[id];

  // After the exact lookups, before the substring walk. A table that names an
  // id has deliberately priced it — Gemini prices several image models — and
  // that is a stronger statement than any matcher. What the guard blocks is the
  // walk BORROWING a sibling's card for an id the table never named.
  if (notTokenBilled?.(id) === true) return undefined;

  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (best !== undefined && key.length <= best.length) continue;
    const at = id.indexOf(key);
    if (at < 0) continue;
    if (at > 0 && !KEY_PREFIX_BOUNDARY.has(id[at - 1]!)) continue;
    const after = id[at + key.length];
    if (after !== undefined && !KEY_SUFFIX_BOUNDARY.has(after)) continue;
    best = key;
  }
  return best === undefined ? undefined : table[best];
}

/** The rates a base card, a `batch` card and a tier card all carry. */
const RATE_FIELDS = [
  "input",
  "output",
  "cached",
  "cacheWrite",
  "imageInput",
  "imageCached",
  "cacheStoragePerHour",
] as const;

/** Currencies name the same unit however they are spelled or padded. */
function isSameCurrency(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** Every rate `declared` states, with the rest taken from `inherited`. */
function mergeRates(declared: ModelPricingBase, inherited: ModelPricingBase): ModelPricingBase {
  return {
    input: declared.input ?? inherited.input,
    output: declared.output ?? inherited.output,
    cached: declared.cached ?? inherited.cached,
    cacheWrite: declared.cacheWrite ?? inherited.cacheWrite,
    imageInput: declared.imageInput ?? inherited.imageInput,
    imageCached: declared.imageCached ?? inherited.imageCached,
    cacheStoragePerHour: declared.cacheStoragePerHour ?? inherited.cacheStoragePerHour,
  };
}

function mergeOptionalRates(
  declared: ModelPricingBase | undefined,
  inherited: ModelPricingBase | undefined
): ModelPricingBase | undefined {
  if (!declared) return inherited;
  if (!inherited) return declared;
  return mergeRates(declared, inherited);
}

/**
 * `tier` with every rate `declared` states removed, or `undefined` when that
 * leaves nothing.
 *
 * A tier is a replacement card for a prompt range or a clock window, so an
 * inherited tier restating a rate the declarer set would override it exactly
 * where a long prompt or an off-peak hour selects the tier — silently undoing
 * the declaration in the cases it was likely entered for.
 */
function tierRatesNotDeclared(
  tier: ModelPricingBase,
  declared: ModelPricingBase
): ModelPricingBase | undefined {
  const kept: ModelPricingBase = {
    input: declared.input === undefined ? tier.input : undefined,
    output: declared.output === undefined ? tier.output : undefined,
    cached: declared.cached === undefined ? tier.cached : undefined,
    cacheWrite: declared.cacheWrite === undefined ? tier.cacheWrite : undefined,
    imageInput: declared.imageInput === undefined ? tier.imageInput : undefined,
    imageCached: declared.imageCached === undefined ? tier.imageCached : undefined,
    cacheStoragePerHour:
      declared.cacheStoragePerHour === undefined ? tier.cacheStoragePerHour : undefined,
  };
  return RATE_FIELDS.some((field) => kept[field] !== undefined) ? kept : undefined;
}

/** Inherited tiers, stripped of what `declared` states and dropped when empty. */
function inheritTiers<T extends { pricing: ModelPricingBase }>(
  tiers: readonly T[] | undefined,
  declared: ModelPricingBase
): T[] | undefined {
  if (!tiers) return undefined;
  const kept: T[] = [];
  for (const tier of tiers) {
    const pricing = tierRatesNotDeclared(tier.pricing, declared);
    if (pricing) kept.push({ ...tier, pricing });
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * A model's effective rate card: the card someone declared for it, merged over
 * the provider's published one field by field.
 *
 * Every rate `declared` omits is filled from `inherited` — including inside
 * `batch` — so a single negotiated `input` rate does not turn the rest of the
 * card into unpriced counters. Two rules keep the result from contradicting
 * what was declared:
 *
 * - **A declared rate wins everywhere.** Inherited tiers drop any rate declared
 *   at the base level, and a tier left with none is dropped whole; otherwise a
 *   provider's over-200K row would re-price a long prompt at the list rate the
 *   declaration replaced. Tiers the declarer supplied are used as given and
 *   none are inherited — they already state what the ranges cost.
 * - **Currencies are never mixed.** A declared card in another currency
 *   inherits nothing, because merging the two would read as one card whose
 *   rates are quietly in two units.
 *
 * Either side may be absent: with no declared card the provider's stands, with
 * no provider card the declared one does, and with neither the result is
 * `undefined` so a missing rate keeps reading as unpriced rather than free.
 */
export function mergeModelPricing(
  declared: ModelPricing | undefined,
  inherited: ModelPricing | undefined
): ModelPricing | undefined {
  if (!declared) return inherited;
  if (!inherited) return declared;
  if (!isSameCurrency(declared.currency, inherited.currency)) return declared;

  return {
    ...mergeRates(declared, inherited),
    currency: declared.currency,
    batch: mergeOptionalRates(declared.batch, inherited.batch),
    usageTiers: declared.usageTiers ?? inheritTiers(inherited.usageTiers, declared),
    timingTiers: declared.timingTiers ?? inheritTiers(inherited.timingTiers, declared),
  };
}

const MINUTES_PER_HOUR = 60;

/** Minutes past 00:00 for an `HH:MM` clock time, or `undefined` if malformed. */
function parseClockMinutes(value: string): number | undefined {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

/**
 * Whether `minutes` past midnight UTC falls in `[start, end)`.
 *
 * An `end` before `start` wraps midnight, which is the normal shape for an
 * off-peak discount. `start === end` is a zero-length window that matches
 * nothing rather than the whole day: a rate card that names the same instant
 * twice states no window, and reading it as "always" would apply a discount
 * around the clock.
 */
function isWithinWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function selectUsageTier(
  tiers: readonly ModelUsageTier[] | undefined,
  inputTokens: number | undefined
): ModelUsageTier | undefined {
  if (!tiers || inputTokens === undefined) return undefined;
  return tiers.find(
    (tier) =>
      inputTokens >= (tier.minInputTokens ?? 0) &&
      inputTokens <= (tier.maxInputTokens ?? Number.POSITIVE_INFINITY)
  );
}

function selectTimingTier(
  tiers: readonly ModelTimingTier[] | undefined,
  at: Date | number | undefined
): ModelTimingTier | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  const date = at === undefined ? new Date() : at instanceof Date ? at : new Date(at);
  const minutes = date.getUTCHours() * MINUTES_PER_HOUR + date.getUTCMinutes();
  if (!Number.isFinite(minutes)) return undefined;
  return tiers.find((tier) => {
    const start = parseClockMinutes(tier.start);
    const end = parseClockMinutes(tier.end);
    // A window nobody can parse is skipped, not guessed at: a malformed clock
    // string must never widen or narrow what a discount applies to.
    return start !== undefined && end !== undefined && isWithinWindow(minutes, start, end);
  });
}

/** Fields a tier may restate. `undefined` in the overlay keeps the base rate. */
function overlayRates(base: ModelPricingBase, over: ModelPricingBase): ModelPricingBase {
  return {
    input: over.input ?? base.input,
    output: over.output ?? base.output,
    cached: over.cached ?? base.cached,
    cacheWrite: over.cacheWrite ?? base.cacheWrite,
    imageInput: over.imageInput ?? base.imageInput,
    imageCached: over.imageCached ?? base.imageCached,
    cacheStoragePerHour: over.cacheStoragePerHour ?? base.cacheStoragePerHour,
  };
}

export interface EffectiveRateOptions {
  /**
   * Prompt size in tokens, used to pick a {@link ModelUsageTier}. This is the
   * whole prompt — plain, cache-read and cache-written input together — because
   * that is what a provider's context threshold measures. Omitted means no
   * usage tier applies.
   */
  readonly inputTokens?: number;
  /**
   * When the request ran, used to pick a {@link ModelTimingTier}. Defaults to
   * now, which is right for a live run and wrong for a replayed one — pass the
   * request's own instant when pricing after the fact.
   */
  readonly at?: Date | number;
}

/**
 * Collapse a rate card and its tiers into the single set of rates that applies
 * to one request.
 *
 * A matching usage tier is applied first and a matching timing tier second, so
 * a time-of-day discount overrides a long-context surcharge on the fields it
 * restates and leaves the rest alone. Each tier overrides only the fields it
 * declares, so a tier that names `input` and `output` keeps the base
 * `cacheWrite` instead of silently dropping it.
 *
 * `batch` is deliberately not consulted: nothing in the pipeline runs a batch
 * request yet, and a rate that no caller can select would only make estimates
 * disagree with invoices.
 */
export function resolveEffectiveRates(
  pricing: ModelPricing,
  options: EffectiveRateOptions = {}
): ModelPricingBase {
  let rates: ModelPricingBase = {
    input: pricing.input,
    output: pricing.output,
    cached: pricing.cached,
    cacheWrite: pricing.cacheWrite,
    imageInput: pricing.imageInput,
    imageCached: pricing.imageCached,
    cacheStoragePerHour: pricing.cacheStoragePerHour,
  };

  const usageTier = selectUsageTier(pricing.usageTiers, options.inputTokens);
  if (usageTier) rates = overlayRates(rates, usageTier.pricing);

  const timingTier = selectTimingTier(pricing.timingTiers, options.at);
  if (timingTier) rates = overlayRates(rates, timingTier.pricing);

  return rates;
}

/**
 * The rate properties every card carries, shared by the model's own card and by
 * the nested `batch` and per-tier cards so all four accept the same rates.
 */
const RATE_PROPERTIES = {
  input: {
    type: "number",
    title: "Input Rate",
    description: "USD per 1M input tokens",
    "x-ui-order": 2,
  },
  output: {
    type: "number",
    title: "Output Rate",
    description: "USD per 1M output tokens",
    "x-ui-order": 3,
  },
  cached: {
    type: "number",
    title: "Cached Input Rate",
    description: "USD per 1M cached input tokens",
    "x-ui-order": 4,
  },
  cacheWrite: {
    title: "Cache Write Rate",
    description: "USD per 1M tokens written to cache, or rates by TTL",
    "x-ui-order": 5,
    anyOf: [
      { type: "number", title: "Flat Rate" },
      {
        type: "object",
        title: "Tiered Write Rates",
        properties: {
          cacheWrite5m: { type: "number", title: "Cache Write (5m TTL)" },
          cacheWrite1h: { type: "number", title: "Cache Write (1h TTL)" },
        },
        additionalProperties: false,
      },
    ],
  },
  imageInput: {
    type: "number",
    title: "Image Input Rate",
    description: "USD per 1M uncached image-input tokens",
    "x-ui-order": 6,
  },
  imageCached: {
    type: "number",
    title: "Cached Image Input Rate",
    description: "USD per 1M cached image-input tokens",
    "x-ui-order": 7,
  },
  cacheStoragePerHour: {
    type: "number",
    title: "Cache Storage Per Hour",
    description: "USD per 1M token-hours stored",
    "x-ui-order": 8,
  },
} as const;

/** A nested rate card: the shared rates and nothing else. */
const RATE_CARD_SCHEMA = {
  type: "object",
  properties: RATE_PROPERTIES,
  additionalProperties: false,
} as const;

/** `HH:MM` on a 24-hour clock. */
const CLOCK_TIME_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

/**
 * JSON schema for per-million-token model pricing rates.
 *
 * Every field is optional past the currency, because a card on a model record
 * states only what someone declared — a negotiated `input` rate, or the whole
 * card for a model no provider table names. Whatever it leaves out the
 * provider's own table answers for ({@link mergeModelPricing}), so a rate
 * correction there reaches every model already added instead of being shadowed
 * by the published rates of the day it was added.
 */
export const ModelPricingSchema = {
  type: "object",
  title: "Pricing",
  description: "Per-million-token rates for this model.",
  properties: {
    currency: { type: "string", default: "USD", title: "Currency", "x-ui-order": 1 },
    ...RATE_PROPERTIES,
    batch: {
      ...RATE_CARD_SCHEMA,
      title: "Batch Rates",
      description: "Rates for a batched request. Not yet applied to cost estimates.",
      "x-ui-order": 9,
    },
    usageTiers: {
      type: "array",
      title: "Usage Tiers",
      description: "Rates that replace the base ones for a prompt in a token range.",
      "x-ui-order": 10,
      items: {
        type: "object",
        properties: {
          minInputTokens: { type: "number", title: "Min Input Tokens" },
          maxInputTokens: { type: "number", title: "Max Input Tokens" },
          pricing: { ...RATE_CARD_SCHEMA, title: "Tier Rates" },
        },
        required: ["pricing"],
        additionalProperties: false,
      },
    },
    timingTiers: {
      type: "array",
      title: "Timing Tiers",
      description: "Rates that replace the base ones inside a daily UTC window.",
      "x-ui-order": 11,
      items: {
        type: "object",
        properties: {
          start: {
            type: "string",
            title: "Start (UTC)",
            description: "HH:MM, inclusive",
            pattern: CLOCK_TIME_PATTERN,
          },
          end: {
            type: "string",
            title: "End (UTC)",
            description: "HH:MM, exclusive; before the start to wrap midnight",
            pattern: CLOCK_TIME_PATTERN,
          },
          pricing: { ...RATE_CARD_SCHEMA, title: "Tier Rates" },
        },
        required: ["start", "end", "pricing"],
        additionalProperties: false,
      },
    },
  },
  required: ["currency"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;
