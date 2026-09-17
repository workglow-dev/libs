/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import { estimateCost } from "../../capability/CostEstimate";
import { formatCost } from "../../capability/formatUsage";
import type { ModelPricing } from "../ModelPricing";
import {
  FREE_LOCAL_PRICING,
  mergeModelPricing,
  ModelPricingSchema,
  resolveEffectiveRates,
  resolveModelPricingFromTable,
} from "../ModelPricing";
import { ModelConfigSchema, ModelRecordSchema } from "../ModelSchema";

describe("model pricing", () => {
  it("is present in the schema, requires currency, but is never required on the model itself", () => {
    // The model schema carries the rate card by reference and types the
    // property shallowly, so assert identity here and the shape on the card.
    expect(ModelConfigSchema.properties.pricing).toBe(ModelPricingSchema);
    expect(ModelRecordSchema.properties.pricing).toBe(ModelPricingSchema);
    expect(ModelPricingSchema.required).toEqual(["currency"]);
    expect(ModelConfigSchema.required).not.toContain("pricing");
    expect(ModelRecordSchema.required).not.toContain("pricing");
  });

  it("defines ModelPricingSchema with rate properties and UI annotations", () => {
    expect(ModelPricingSchema.type).toBe("object");
    expect(ModelPricingSchema.properties.currency).toBeDefined();
    expect(ModelPricingSchema.properties.input).toBeDefined();
    expect(ModelPricingSchema.properties.output).toBeDefined();
    expect(ModelPricingSchema.properties.cached).toBeDefined();
    expect(ModelPricingSchema.properties.cacheWrite).toBeDefined();
    expect(ModelPricingSchema.properties.imageInput).toBeDefined();
    expect(ModelPricingSchema.properties.imageCached).toBeDefined();
    expect(ModelPricingSchema.properties.cacheStoragePerHour).toBeDefined();
    expect(ModelPricingSchema.properties.batch).toBeDefined();
    expect(ModelPricingSchema.properties.usageTiers).toBeDefined();
    expect(ModelPricingSchema.properties.timingTiers).toBeDefined();
    expect(ModelPricingSchema.properties.currency["x-ui-order"]).toBe(1);
    expect(ModelPricingSchema.properties.input["x-ui-order"]).toBe(2);
    expect(ModelPricingSchema.properties.imageInput["x-ui-order"]).toBe(6);
    expect(ModelPricingSchema.properties.imageCached["x-ui-order"]).toBe(7);
  });

  it("defines FREE_LOCAL_PRICING with zero rates", () => {
    expect(FREE_LOCAL_PRICING).toEqual({
      currency: "USD",
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      imageInput: 0,
      imageCached: 0,
      cacheStoragePerHour: undefined,
    });
  });
});

describe("resolveModelPricingFromTable", () => {
  const table: Record<string, ModelPricing> = {
    "gpt-5": { currency: "USD", input: 2.5, output: 10 },
    "gpt-5-mini": { currency: "USD", input: 0.15, output: 0.6 },
    "gpt-4o": { currency: "USD", input: 2.5, output: 10 },
    o1: { currency: "USD", input: 15, output: 60 },
  };

  it("matches an exact id and strips a vendor prefix", () => {
    expect(resolveModelPricingFromTable(table, "gpt-4o")).toBe(table["gpt-4o"]);
    expect(resolveModelPricingFromTable(table, "OpenAI/GPT-4o", ["openai/"])).toBe(table["gpt-4o"]);
  });

  it("resolves a dated or sized variant to its family, longest key first", () => {
    expect(resolveModelPricingFromTable(table, "gpt-4o-2024-08-06")).toBe(table["gpt-4o"]);
    expect(resolveModelPricingFromTable(table, "gpt-5-mini-2026-01-01")).toBe(table["gpt-5-mini"]);
  });

  it("leaves a sibling point release unpriced rather than borrowing a rate", () => {
    // The dot marks a different rate card; "gpt-5.6" must not become "gpt-5".
    expect(resolveModelPricingFromTable(table, "gpt-5.6")).toBeUndefined();
    expect(resolveModelPricingFromTable(table, "gpt-5.6-terra")).toBeUndefined();
  });

  it("does not match a short key mid-token", () => {
    expect(resolveModelPricingFromTable(table, "o1-preview")).toBe(table["o1"]);
    expect(resolveModelPricingFromTable(table, "mono1-chat")).toBeUndefined();
  });

  it("never returns an Object.prototype member for a prototype-named id", () => {
    expect(resolveModelPricingFromTable(table, "constructor")).toBeUndefined();
    expect(resolveModelPricingFromTable(table, "toString")).toBeUndefined();
  });

  describe("notTokenBilled", () => {
    // A dash is a legal suffix boundary — that is what resolves a dated variant
    // to its family — so an id like `gpt-4o-image` reaches `gpt-4o`'s card. For
    // a model billed per image that is a fabricated unit rather than an
    // approximation, and a provider says so by passing its own matcher.
    const isImage = (id: string): boolean => /(?:^|-)image(?:-|$)/i.test(id);

    it("blocks the substring walk from borrowing a sibling's card", () => {
      expect(resolveModelPricingFromTable(table, "gpt-4o-image")).toBe(table["gpt-4o"]);
      expect(resolveModelPricingFromTable(table, "gpt-4o-image", [], isImage)).toBeUndefined();
    });

    it("does not override an id the table names outright", () => {
      // Consulted AFTER the exact lookups: a table that prices an image model
      // has declared a rate deliberately, which is a stronger statement than any
      // matcher. Only the borrowing is blocked.
      const withImage: Record<string, ModelPricing> = {
        ...table,
        "gpt-image-1": { currency: "USD", input: 5, output: 40 },
      };
      expect(resolveModelPricingFromTable(withImage, "gpt-image-1", [], isImage)).toBe(
        withImage["gpt-image-1"]
      );
    });

    it("sees the same id the walk does, prefix stripped and lower-cased", () => {
      // A provider writes the matcher for the bare id its table is keyed on, so
      // an anchored one only fires if the guard is asked about the stripped
      // form. Asked about the raw id, `models/gpt-4o-image` walks straight past
      // it and takes `gpt-4o`'s per-token card for a model billed per image.
      const anchoredImage = (id: string): boolean => /^gpt-.*-image(?:-|$)/i.test(id);
      expect(
        resolveModelPricingFromTable(table, "gpt-4o-image", [], anchoredImage)
      ).toBeUndefined();
      expect(
        resolveModelPricingFromTable(table, "models/gpt-4o-image", ["models/"], anchoredImage)
      ).toBeUndefined();
      expect(
        resolveModelPricingFromTable(table, "OpenAI/GPT-4o-Image", ["openai/"], anchoredImage)
      ).toBeUndefined();
    });

    it("leaves a text id alone, and is optional", () => {
      expect(resolveModelPricingFromTable(table, "gpt-4o", [], isImage)).toBe(table["gpt-4o"]);
      expect(resolveModelPricingFromTable(table, "gpt-4o-2024-08-06", [], isImage)).toBe(
        table["gpt-4o"]
      );
      expect(resolveModelPricingFromTable(table, "gpt-4o", [], () => false)).toBe(table["gpt-4o"]);
    });
  });
});

describe("resolveEffectiveRates", () => {
  const base: ModelPricing = { currency: "USD", input: 3, output: 15, cached: 0.3 };

  it("returns the base rates when the card declares no tiers", () => {
    expect(resolveEffectiveRates(base)).toEqual({
      input: 3,
      output: 15,
      cached: 0.3,
      cacheWrite: undefined,
      imageInput: undefined,
      imageCached: undefined,
      cacheStoragePerHour: undefined,
    });
  });

  describe("usage tiers", () => {
    const tiered: ModelPricing = {
      ...base,
      usageTiers: [
        { maxInputTokens: 200_000, pricing: { input: 3, output: 15 } },
        { minInputTokens: 200_000, pricing: { input: 6, output: 22.5 } },
      ],
    };

    it("picks the tier the prompt falls in", () => {
      expect(resolveEffectiveRates(tiered, { inputTokens: 1_000 }).input).toBe(3);
      expect(resolveEffectiveRates(tiered, { inputTokens: 200_001 }).input).toBe(6);
    });

    it("resolves a boundary overlap to the earlier tier", () => {
      // Both tiers name 200_000; published order decides, so the long-context
      // surcharge does not start one token early.
      expect(resolveEffectiveRates(tiered, { inputTokens: 200_000 }).input).toBe(3);
    });

    it("applies no tier when the prompt size is unknown", () => {
      expect(resolveEffectiveRates(tiered).input).toBe(3);
    });

    it("counts the whole prompt, not just the plain input counter", () => {
      // A prompt mostly served from cache is still a large prompt.
      expect(resolveEffectiveRates(tiered, { inputTokens: 199_000 }).input).toBe(3);
      expect(resolveEffectiveRates(tiered, { inputTokens: 260_000 }).input).toBe(6);
    });
  });

  describe("timing tiers", () => {
    const discounted: ModelPricing = {
      ...base,
      timingTiers: [
        { start: "16:30", end: "00:30", pricing: { input: 1.5, output: 7.5, cached: 0.15 } },
      ],
    };

    const at = (iso: string): Date => new Date(iso);

    it("applies the discount inside the window", () => {
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T18:00:00Z") }).input).toBe(1.5);
    });

    it("carries the window across midnight", () => {
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T23:59:00Z") }).input).toBe(1.5);
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T00:00:00Z") }).input).toBe(1.5);
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T00:29:00Z") }).input).toBe(1.5);
    });

    it("charges the base rate outside the window, at both open ends", () => {
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T00:30:00Z") }).input).toBe(3);
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T16:29:00Z") }).input).toBe(3);
    });

    it("reads the window in UTC, not the host's local clock", () => {
      // 16:30 UTC is inside; the same wall-clock reading in any other zone is
      // a different instant and must not decide the rate.
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T16:30:00Z") }).input).toBe(1.5);
      expect(resolveEffectiveRates(discounted, { at: at("2026-09-04T16:30:00-08:00") }).input).toBe(
        3
      );
    });

    it("accepts an epoch millisecond timestamp", () => {
      expect(
        resolveEffectiveRates(discounted, { at: Date.parse("2026-09-04T18:00:00Z") }).input
      ).toBe(1.5);
    });

    it("skips a window whose clock times do not parse", () => {
      const malformed: ModelPricing = {
        ...base,
        timingTiers: [{ start: "6:30pm", end: "24:00", pricing: { input: 0 } }],
      };
      expect(resolveEffectiveRates(malformed, { at: at("2026-09-04T18:00:00Z") }).input).toBe(3);
    });

    it("treats a zero-length window as matching nothing rather than everything", () => {
      const empty: ModelPricing = {
        ...base,
        timingTiers: [{ start: "12:00", end: "12:00", pricing: { input: 0 } }],
      };
      expect(resolveEffectiveRates(empty, { at: at("2026-09-04T12:00:00Z") }).input).toBe(3);
    });
  });

  it("overrides only the rates a tier restates", () => {
    const partial: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheStoragePerHour: 1,
      timingTiers: [{ start: "00:00", end: "12:00", pricing: { input: 1.5 } }],
    };
    expect(resolveEffectiveRates(partial, { at: new Date("2026-09-04T06:00:00Z") })).toEqual({
      input: 1.5,
      output: 15,
      cached: undefined,
      cacheWrite: 3.75,
      imageInput: undefined,
      imageCached: undefined,
      cacheStoragePerHour: 1,
    });
  });

  it("lets a timing tier override a usage tier on the rates both name", () => {
    const both: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      usageTiers: [{ minInputTokens: 200_000, pricing: { input: 6, output: 22.5 } }],
      timingTiers: [{ start: "00:00", end: "12:00", pricing: { input: 1.5 } }],
    };
    // The long-context surcharge still sets `output`; the discount wins `input`.
    expect(
      resolveEffectiveRates(both, {
        inputTokens: 300_000,
        at: new Date("2026-09-04T06:00:00Z"),
      })
    ).toEqual({
      input: 1.5,
      output: 22.5,
      cached: undefined,
      cacheWrite: undefined,
      imageInput: undefined,
      imageCached: undefined,
      cacheStoragePerHour: undefined,
    });
  });
});

describe("mergeModelPricing", () => {
  // A stand-in for a provider's published card: every rate filled in, plus the
  // long-context rows and a batch card, so a partial declaration has something
  // of each kind to inherit.
  const provider: ModelPricing = {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: 3.75,
    cacheStoragePerHour: 1,
    batch: { input: 1.5, output: 7.5 },
    usageTiers: [
      { maxInputTokens: 200_000, pricing: { input: 3, output: 15 } },
      { minInputTokens: 200_000, pricing: { input: 6, output: 22.5 } },
    ],
  };

  it("fills every rate the declared card leaves unset", () => {
    // The case that motivates the merge: someone enters one negotiated rate.
    // The rest must stay priced instead of reading as unpriced counters.
    const merged = mergeModelPricing({ currency: "USD", input: 1 }, provider);
    expect(merged?.input).toBe(1);
    expect(merged?.output).toBe(15);
    expect(merged?.cached).toBe(0.3);
    expect(merged?.cacheWrite).toBe(3.75);
    expect(merged?.cacheStoragePerHour).toBe(1);
  });

  it("keeps a declared rate of zero rather than treating it as unset", () => {
    // A free-tier or comped rate is a declaration, and `0` must not fall
    // through to the provider's list rate the way `undefined` does.
    expect(mergeModelPricing({ currency: "USD", input: 0 }, provider)?.input).toBe(0);
  });

  it("keeps a declared rate over an inherited tier that would re-price it", () => {
    // The tier is a replacement card for prompts over 200K. Inherited whole it
    // would put the provider's `input: 6` back on exactly the long prompts the
    // negotiated rate was entered for, so the tier keeps only `output`.
    const merged = mergeModelPricing({ currency: "USD", input: 1 }, provider);
    const rates = resolveEffectiveRates(merged!, { inputTokens: 300_000 });
    expect(rates.input).toBe(1);
    expect(rates.output).toBe(22.5);
  });

  it("drops an inherited tier that restates nothing else", () => {
    // Both of the provider's tiers name only `input` and `output`; declaring
    // both leaves each tier empty, and an empty tier is not worth carrying.
    const merged = mergeModelPricing({ currency: "USD", input: 1, output: 2 }, provider);
    expect(merged?.usageTiers).toBeUndefined();
    expect(resolveEffectiveRates(merged!, { inputTokens: 300_000 }).input).toBe(1);
  });

  it("uses the declarer's own tiers as given and inherits none", () => {
    // Tiers someone supplied already say what each range costs; splicing the
    // provider's rows in beside them would price ranges nobody declared.
    const merged = mergeModelPricing(
      {
        currency: "USD",
        input: 1,
        usageTiers: [{ minInputTokens: 500_000, pricing: { input: 2 } }],
      },
      provider
    );
    expect(merged?.usageTiers).toEqual([{ minInputTokens: 500_000, pricing: { input: 2 } }]);
    // 300K falls in the provider's over-200K row and in none of the declared
    // ones, so it is priced at the declared base rate.
    expect(resolveEffectiveRates(merged!, { inputTokens: 300_000 }).input).toBe(1);
    expect(resolveEffectiveRates(merged!, { inputTokens: 600_000 }).input).toBe(2);
  });

  it("inherits timing tiers under the same rule", () => {
    const offPeak: ModelPricing = {
      currency: "USD",
      input: 3,
      output: 15,
      timingTiers: [{ start: "00:00", end: "12:00", pricing: { input: 1.5, output: 7.5 } }],
    };
    const merged = mergeModelPricing({ currency: "USD", input: 1 }, offPeak);
    const rates = resolveEffectiveRates(merged!, { at: new Date("2026-09-04T06:00:00Z") });
    expect(rates.input).toBe(1);
    expect(rates.output).toBe(7.5);
  });

  it("inherits nothing from a card in another currency", () => {
    // Two currencies merged field by field would read as one card whose rates
    // are silently in different units, which no downstream sum can detect.
    const merged = mergeModelPricing({ currency: "EUR", input: 1 }, provider);
    expect(merged).toEqual({ currency: "EUR", input: 1 });
  });

  it("still inherits when the same currency is spelled differently", () => {
    expect(mergeModelPricing({ currency: "usd", input: 1 }, provider)?.output).toBe(15);
  });

  it("merges the batch card field by field too", () => {
    const merged = mergeModelPricing({ currency: "USD", batch: { input: 0.5 } }, provider);
    expect(merged?.batch).toEqual({ input: 0.5, output: 7.5 });
  });

  it("keeps the provider's batch card when the declared one says nothing", () => {
    expect(mergeModelPricing({ currency: "USD", input: 1 }, provider)?.batch).toEqual({
      input: 1.5,
      output: 7.5,
    });
  });

  it("returns the provider's card unchanged when nothing is declared", () => {
    expect(mergeModelPricing(undefined, provider)).toBe(provider);
  });

  it("returns the declared card when the provider prices nothing", () => {
    const declared: ModelPricing = { currency: "USD", input: 1 };
    expect(mergeModelPricing(declared, undefined)).toBe(declared);
  });

  it("stays undefined when neither side prices the model, and reads as unpriced", () => {
    // `undefined` must never collapse to a zero card: an unpriced model has to
    // keep printing the partial marker rather than a confident free run.
    expect(mergeModelPricing(undefined, undefined)).toBeUndefined();

    const usage: Usage = {
      input: 1_000,
      output: 500,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    };
    expect(estimateCost(usage, mergeModelPricing(undefined, undefined))).toBeUndefined();

    // And a merged card that prices only part of what was spent still marks
    // the figure partial with `~`.
    const partial = mergeModelPricing({ currency: "USD", input: 1 }, undefined);
    const estimate = estimateCost(usage, partial);
    expect(estimate?.unpriced).toEqual(["output"]);
    expect(formatCost(estimate)).toBe("~$0.0010");
    expect(formatCost(undefined)).toBe("");
  });
});
