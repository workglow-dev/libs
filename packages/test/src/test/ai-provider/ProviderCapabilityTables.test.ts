/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ANTHROPIC_PRICING, _testOnly as anthropic } from "@workglow/anthropic/ai";
import { OPENAI_PRICING, _testOnly as openai } from "@workglow/openai/ai";
import { describe, expect, it } from "vitest";

const { resolveAnthropicOutputFormatSupport, resolveAnthropicForcedToolChoice } = anthropic;
const { resolveOpenAiTemperatureWithReasoning, finalizeResponsesRequest } = openai;

const claude = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "ANTHROPIC", provider_config: { model_name, ...extra } }) as never;
const gpt = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "OPENAI", provider_config: { model_name, ...extra } }) as never;

describe("capability tables cover every priced model", () => {
  it.each(Object.keys(ANTHROPIC_PRICING))(
    "resolves %s from a table entry for each Anthropic capability",
    (id) => {
      expect(resolveAnthropicOutputFormatSupport(claude(id)).source).toBe("table");
      expect(resolveAnthropicForcedToolChoice(claude(id)).source).toBe("table");
    }
  );

  it.each(Object.keys(OPENAI_PRICING))(
    "resolves %s from a table entry for OpenAI temperature-with-reasoning",
    (id) => {
      expect(resolveOpenAiTemperatureWithReasoning(gpt(id)).source).toBe("table");
    }
  );
});

describe("future and unreadable ids take a documented default", () => {
  it("gives a future Claude generation the newest known profile", () => {
    expect(resolveAnthropicOutputFormatSupport(claude("claude-opus-6"))).toEqual({
      value: true,
      source: "default",
    });
    expect(resolveAnthropicForcedToolChoice(claude("claude-opus-6"))).toEqual({
      value: false,
      source: "default",
    });
  });

  it("gives an unreadable Claude id the legacy profile", () => {
    expect(resolveAnthropicOutputFormatSupport(claude("mystery"))).toEqual({
      value: false,
      source: "default",
    });
    expect(resolveAnthropicForcedToolChoice(claude("mystery"))).toEqual({
      value: true,
      source: "default",
    });
  });

  it("does not guess at an unknown OpenAI model", () => {
    expect(resolveOpenAiTemperatureWithReasoning(gpt("gpt-7-nova"))).toEqual({
      value: false,
      source: "default",
    });
  });
});

describe("a model record overrides each capability", () => {
  it("overrides output format support in both directions", () => {
    expect(
      resolveAnthropicOutputFormatSupport(
        claude("claude-opus-5-5", { supports_output_format: false })
      )
    ).toEqual({ value: false, source: "override" });
    expect(
      resolveAnthropicOutputFormatSupport(
        claude("claude-sonnet-4-5", { supports_output_format: true })
      )
    ).toEqual({ value: true, source: "override" });
  });

  it("overrides forced tool choice in both directions", () => {
    expect(
      resolveAnthropicForcedToolChoice(
        claude("claude-opus-5-5", { accepts_forced_tool_choice: true })
      )
    ).toEqual({ value: true, source: "override" });
    expect(
      resolveAnthropicForcedToolChoice(
        claude("claude-sonnet-4-5", { accepts_forced_tool_choice: false })
      )
    ).toEqual({ value: false, source: "override" });
  });

  it("lets a model the table rejects keep a pinned temperature", () => {
    const params = finalizeResponsesRequest(
      gpt("gpt-5.5", { accepts_temperature_with_reasoning: true }),
      { model: "gpt-5.5", temperature: 0.2 }
    );
    expect(params).toMatchObject({ reasoning: { effort: "none" }, temperature: 0.2 });
  });

  it("can switch the GPT-5.6 default off", () => {
    const params = finalizeResponsesRequest(
      gpt("gpt-5.6-luna", { accepts_temperature_with_reasoning: false }),
      { model: "gpt-5.6-luna", temperature: 0.2 }
    );
    expect(params.temperature).toBeUndefined();
  });
});
