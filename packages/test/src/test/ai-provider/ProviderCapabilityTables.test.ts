/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ANTHROPIC_PRICING, _testOnly as anthropic } from "@workglow/anthropic/ai";
import { OPENAI_PRICING, _testOnly as openai } from "@workglow/openai/ai";
import { describe, expect, it } from "vitest";

const {
  resolveAnthropicOutputFormatSupport,
  resolveAnthropicForcedToolChoice,
  ANTHROPIC_MODEL_PROFILES,
  ANTHROPIC_UNPRICED_PROFILE_IDS,
  normalizeAnthropicModelId,
  resolveAnthropicProfile,
  inferAnthropicCapabilities,
} = anthropic;
const {
  resolveOpenAiTemperatureWithReasoning,
  finalizeResponsesRequest,
  OPENAI_MODEL_PROFILES,
  OPENAI_UNPRICED_PROFILE_IDS,
  normalizeOpenAiModelId,
  resolveOpenAiProfile,
  inferOpenAiCapabilities,
} = openai;

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

describe("profile tables and pricing tables are one set of models", () => {
  it("has a profile row for every priced Anthropic model, and only the named extras besides", () => {
    const priced = new Set(Object.keys(ANTHROPIC_PRICING).map(normalizeAnthropicModelId));
    const profiled = new Set(Object.keys(ANTHROPIC_MODEL_PROFILES));
    expect([...priced].filter((id) => !profiled.has(id))).toEqual([]);
    expect([...profiled].filter((id) => !priced.has(id)).sort()).toEqual(
      [...ANTHROPIC_UNPRICED_PROFILE_IDS].sort()
    );
  });

  it("has a profile row for every priced OpenAI model, and only the named extras besides", () => {
    const priced = new Set(Object.keys(OPENAI_PRICING).map(normalizeOpenAiModelId));
    const profiled = new Set(Object.keys(OPENAI_MODEL_PROFILES));
    expect([...priced].filter((id) => !profiled.has(id))).toEqual([]);
    expect([...profiled].filter((id) => !priced.has(id)).sort()).toEqual(
      [...OPENAI_UNPRICED_PROFILE_IDS].sort()
    );
  });

  it("keys every row by its own canonical id", () => {
    for (const id of Object.keys(ANTHROPIC_MODEL_PROFILES)) {
      expect(normalizeAnthropicModelId(id)).toBe(id);
    }
    for (const id of Object.keys(OPENAI_MODEL_PROFILES))
      expect(normalizeOpenAiModelId(id)).toBe(id);
  });

  it("states every flag of every row explicitly", () => {
    for (const row of Object.values(ANTHROPIC_MODEL_PROFILES)) {
      expect(typeof row.supportsOutputFormat).toBe("boolean");
      expect(typeof row.acceptsForcedToolChoice).toBe("boolean");
      expect(typeof row.vision).toBe("boolean");
    }
    for (const row of Object.values(OPENAI_MODEL_PROFILES)) {
      expect(typeof row.acceptsTemperatureWithReasoning).toBe("boolean");
      expect(typeof row.vision).toBe("boolean");
      expect(["chat", "embedding", "image-generation", "image-editing"]).toContain(row.kind);
    }
  });

  it.each(Object.keys(ANTHROPIC_PRICING))(
    "agrees between request flags, inference and the profile for %s",
    (id) => {
      const { profile, source } = resolveAnthropicProfile(id);
      expect(source).toBe("table");
      expect(resolveAnthropicOutputFormatSupport(claude(id)).value).toBe(
        profile.supportsOutputFormat
      );
      expect(resolveAnthropicForcedToolChoice(claude(id)).value).toBe(
        profile.acceptsForcedToolChoice
      );
      const caps = inferAnthropicCapabilities({ model_id: id } as never);
      expect(caps.includes("vision-input")).toBe(profile.vision);
      expect(caps).toContain("text.generation");
    }
  );

  it.each(Object.keys(OPENAI_PRICING))(
    "agrees between request flags, inference and the profile for %s",
    (id) => {
      const { profile, source } = resolveOpenAiProfile(id);
      expect(source).toBe("table");
      expect(resolveOpenAiTemperatureWithReasoning(gpt(id)).value).toBe(
        profile!.acceptsTemperatureWithReasoning
      );
      const caps = inferOpenAiCapabilities({ model_id: id } as never);
      expect(caps.includes("text.embedding")).toBe(profile!.kind === "embedding");
      expect(caps.includes("image.editing")).toBe(profile!.kind === "image-editing");
      expect(caps.includes("text.generation")).toBe(profile!.kind === "chat");
      expect(caps.includes("vision-input")).toBe(profile!.kind === "chat" && profile!.vision);
    }
  );
});

describe("gateway spellings normalize to the canonical id", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["anthropic/claude-opus-4.5", "claude-opus-4-5"],
    ["anthropic/claude-3.5-sonnet", "claude-3-5-sonnet"],
    ["anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5"],
    ["us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5"],
    ["eu.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet"],
    ["claude-sonnet-4-5@20250929", "claude-sonnet-4-5"],
    ["claude-opus-4-1@latest", "claude-opus-4-1"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["  Claude-Haiku-4-5-20251001 ", "claude-haiku-4-5"],
    ["claude-2.1", "claude-2.1"],
    ["claude-instant-1.2", "claude-instant-1.2"],
  ])("maps %s to %s", (spelling, canonical) => {
    expect(normalizeAnthropicModelId(spelling)).toBe(canonical);
  });

  it.each([
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
    ["GPT-4o-2024-08-06", "gpt-4o"],
    ["openai/gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
  ])("maps %s to %s", (spelling, canonical) => {
    expect(normalizeOpenAiModelId(spelling)).toBe(canonical);
  });

  it("gives every spelling of a model the same decision", () => {
    for (const spelling of [
      "anthropic/claude-opus-5-5",
      "us.anthropic.claude-opus-5-5-v1:0",
      "claude-opus-5-5@20260101",
    ]) {
      expect(resolveAnthropicForcedToolChoice(claude(spelling))).toEqual({
        value: false,
        source: "table",
      });
    }
    expect(resolveOpenAiTemperatureWithReasoning(gpt("openai/gpt-5.6-luna-2026-01-01"))).toEqual({
      value: true,
      source: "table",
    });
  });
});

describe("capability inference for ids outside the table", () => {
  it("serves vision to a Claude 3 or 4 id and none to Claude 2", () => {
    expect(inferAnthropicCapabilities({ model_id: "claude-sonnet-4-9" } as never)).toContain(
      "vision-input"
    );
    expect(inferAnthropicCapabilities({ model_id: "claude-3-sonnet-20240229" } as never)).toContain(
      "vision-input"
    );
    expect(inferAnthropicCapabilities({ model_id: "claude-2.1" } as never)).not.toContain(
      "vision-input"
    );
  });

  it("keeps what an unrecognized record declared", () => {
    expect(
      inferAnthropicCapabilities({
        model_id: "mystery",
        capabilities: ["text.generation"],
      } as never)
    ).toEqual(["text.generation"]);
    expect(inferOpenAiCapabilities({ model_id: "mystery" } as never)).toEqual([
      "model.search",
      "model.info",
    ]);
  });

  it("derives an unlisted OpenAI model's kind from its family", () => {
    expect(inferOpenAiCapabilities({ model_id: "dall-e-3" } as never)).toEqual([
      "image.generation",
      "model.info",
      "model.search",
    ]);
    expect(inferOpenAiCapabilities({ model_id: "gpt-4-turbo" } as never)).toContain("vision-input");
  });
});
