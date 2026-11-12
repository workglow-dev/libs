/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GOOGLE_GEMINI, _testOnly } from "@workglow/google-gemini/ai";
import { describe, expect, it } from "vitest";

const { resolveThinkingConfig } = _testOnly;

const legacy = (extra: Record<string, unknown> = {}) =>
  model({ provider_config: { model_name: "gemini-2.5-flash" }, ...extra });

function model(extra: Record<string, unknown> = {}) {
  return {
    provider: GOOGLE_GEMINI,
    provider_config: { model_name: "gemini-3.8-flash" },
    ...extra,
  } as never;
}

describe("resolveThinkingConfig", () => {
  it("without defaultBudget leaves maxTokens unchanged when unset", () => {
    expect(resolveThinkingConfig(model(), 4096)).toEqual({
      thinkingConfig: undefined,
      maxOutputTokens: 4096,
    });
  });

  it("maps model.effort to a budget on 2.5 when thinking_budget unset", () => {
    expect(resolveThinkingConfig(legacy({ effort: "high" }), 1000)).toEqual({
      thinkingConfig: { thinkingBudget: 2048 },
      maxOutputTokens: 1000 + 2048,
    });
  });

  it("provider_config.thinking_budget wins over effort", () => {
    expect(
      resolveThinkingConfig(
        model({
          effort: "ultra",
          provider_config: { model_name: "gemini-3.8-flash", thinking_budget: 0 },
        }),
        1000
      )
    ).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 1000,
    });
  });

  it("maps none through ultra to the pinned budgets on 2.5", () => {
    const expected: Record<string, number> = {
      none: 0,
      low: 512,
      medium: 1024,
      high: 2048,
      extra: 4096,
      ultra: 8192,
    };
    for (const [effort, budget] of Object.entries(expected)) {
      const result = resolveThinkingConfig(legacy({ effort }), 100);
      expect(result.thinkingConfig).toEqual({ thinkingBudget: budget });
      expect(result.maxOutputTokens).toBe(budget > 0 ? 100 + budget : 100);
    }
  });

  it("does not map model.effort on embedding or image models", () => {
    expect(
      resolveThinkingConfig(
        model({
          effort: "high",
          provider_config: { model_name: "gemini-embedding-001" },
        }),
        1000
      )
    ).toEqual({ thinkingConfig: undefined, maxOutputTokens: 1000 });
    expect(
      resolveThinkingConfig(
        model({
          effort: "ultra",
          provider_config: { model_name: "imagen-4.0-generate-001" },
        }),
        1000
      )
    ).toEqual({ thinkingConfig: undefined, maxOutputTokens: 1000 });
  });

  it("honours effort_options even when the class policy would allow the effort", () => {
    expect(resolveThinkingConfig(model({ effort: "high", effort_options: [] }), 1000)).toEqual({
      thinkingConfig: undefined,
      maxOutputTokens: 1000,
    });
  });
  describe("includeThoughts option", () => {
    const flash = (extra: Record<string, unknown> = {}) =>
      model({ provider_config: { model_name: "gemini-2.5-flash" }, ...extra });

    it("asks for thoughts with no budget when no effort is set", () => {
      expect(resolveThinkingConfig(flash(), 100, undefined, { includeThoughts: true })).toEqual({
        thinkingConfig: { includeThoughts: true },
        maxOutputTokens: 100,
      });
    });

    it("adds includeThoughts beside the effort budget and pads the output cap", () => {
      expect(
        resolveThinkingConfig(flash({ effort: "high" }), 100, undefined, { includeThoughts: true })
      ).toEqual({
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
        maxOutputTokens: 2148,
      });
    });

    it("sends nothing for a model that does not think", () => {
      for (const model_name of ["gemini-embedding-001", "imagen-4.0-generate-001"]) {
        expect(
          resolveThinkingConfig(model({ provider_config: { model_name } }), 100, undefined, {
            includeThoughts: true,
          })
        ).toEqual({ thinkingConfig: undefined, maxOutputTokens: 100 });
      }
    });

    it("does not ask a model from before Gemini 2.5 for thoughts", () => {
      for (const model_name of ["gemini-1.5-pro", "gemini-2.0-flash", "gemini-pro"]) {
        expect(
          resolveThinkingConfig(model({ provider_config: { model_name } }), 100, undefined, {
            includeThoughts: true,
          })
        ).toEqual({ thinkingConfig: undefined, maxOutputTokens: 100 });
      }
    });

    it("asks a -latest alias and Gemini 3 for thoughts", () => {
      for (const model_name of ["gemini-flash-latest", "gemini-3.5-pro"]) {
        expect(
          resolveThinkingConfig(model({ provider_config: { model_name } }), 100, undefined, {
            includeThoughts: true,
          })
        ).toEqual({ thinkingConfig: { includeThoughts: true }, maxOutputTokens: 100 });
      }
    });

    it("does not ask for thoughts when the budget is zero", () => {
      expect(
        resolveThinkingConfig(flash({ effort: "none" }), 100, undefined, { includeThoughts: true })
      ).toEqual({ thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 100 });
    });

    it("leaves calls without the option unchanged", () => {
      expect(resolveThinkingConfig(flash(), 100)).toEqual({
        thinkingConfig: undefined,
        maxOutputTokens: 100,
      });
      expect(resolveThinkingConfig(flash({ effort: "high" }), 100, undefined, {})).toEqual({
        thinkingConfig: { thinkingBudget: 2048 },
        maxOutputTokens: 2148,
      });
    });
  });

  describe("effort on models that take a thinking level", () => {
    it("maps none through ultra to levels and pads nothing", () => {
      const expected: Record<string, string> = {
        none: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        extra: "xhigh",
        ultra: "xhigh",
      };
      for (const [effort, level] of Object.entries(expected)) {
        expect(resolveThinkingConfig(model({ effort }), 100)).toEqual({
          thinkingConfig: { thinkingLevel: level },
          maxOutputTokens: 100,
        });
      }
    });

    // Argon and Carbon take low, medium and high; Hydrogen adds xhigh; 3.5
    // Flash-Lite tops out at high. A level a model does not take is a 400.
    it.each([
      ["gemini-4-argon", { none: "low", medium: "medium", extra: "high", ultra: "high" }],
      ["gemini-4-carbon", { none: "low", high: "high", ultra: "high" }],
      ["gemini-4-hydrogen", { none: "low", low: "low", extra: "xhigh", ultra: "xhigh" }],
      ["gemini-4-neon", { none: "low", ultra: "high" }],
      ["gemini-3.5-flash-lite", { none: "minimal", high: "high", ultra: "high" }],
    ] as const)("clamps effort to the levels %s takes", (model_name, expected) => {
      for (const [effort, level] of Object.entries(expected)) {
        expect([
          effort,
          resolveThinkingConfig(model({ effort, provider_config: { model_name } }), 100),
        ]).toEqual([effort, { thinkingConfig: { thinkingLevel: level }, maxOutputTokens: 100 }]);
      }
    });

    it("sends a level for any spelling of a Gemini 3+ id", () => {
      expect(
        resolveThinkingConfig(
          model({ effort: "high", provider_config: { model_name: "models/gemini-4-argon" } }),
          100
        )
      ).toEqual({ thinkingConfig: { thinkingLevel: "high" }, maxOutputTokens: 100 });
    });

    it("keeps an explicit thinking_budget as a budget", () => {
      expect(
        resolveThinkingConfig(
          model({
            effort: "high",
            provider_config: { model_name: "gemini-3.8-flash", thinking_budget: 1024 },
          }),
          100
        )
      ).toEqual({ thinkingConfig: { thinkingBudget: 1024 }, maxOutputTokens: 1124 });
    });
  });

  describe("thinking_level", () => {
    const withLevel = (model_name: string, extra: Record<string, unknown> = {}) =>
      model({ provider_config: { model_name, thinking_level: "xhigh" }, ...extra });

    it("sends the level on Gemini 3+ and pads nothing", () => {
      expect(resolveThinkingConfig(withLevel("gemini-3.8-flash"), 100)).toEqual({
        thinkingConfig: { thinkingLevel: "xhigh" },
        maxOutputTokens: 100,
      });
    });

    it("replaces a budget or effort rather than sending both", () => {
      expect(
        resolveThinkingConfig(withLevel("gemini-3.8-flash", { effort: "ultra" }), 100)
      ).toEqual({ thinkingConfig: { thinkingLevel: "xhigh" }, maxOutputTokens: 100 });
    });

    it("is ignored on 2.5, which answers 400 to a level", () => {
      expect(resolveThinkingConfig(withLevel("gemini-2.5-flash"), 100)).toEqual({
        thinkingConfig: undefined,
        maxOutputTokens: 100,
      });
    });
  });
});
