/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRecord } from "@workglow/ai";
import {
  _testOnly,
  assertNotTruncatedByReasoning,
  DEEPSEEK_ALLOWED_HOSTS,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_REASONING_ALLOWANCE,
  reasoningParams,
  resolveMaxTokens,
} from "@workglow/deepseek/ai";
import { describe, expect, it } from "vitest";

const { DeepSeekQueuedProvider, DEEPSEEK_RUN_FN_SPECS, DEEPSEEK_RUN_FNS } = _testOnly;

function model(model_id: string, capabilities: readonly string[] = []): ModelRecord {
  return {
    model_id,
    title: model_id,
    description: "",
    provider: "DEEPSEEK",
    provider_config: { model_name: model_id },
    capabilities: [...capabilities],
    metadata: {},
  } as ModelRecord;
}

describe("DeepSeekQueuedProvider.inferCapabilities", () => {
  const provider = new DeepSeekQueuedProvider(DEEPSEEK_RUN_FNS);

  it("infers chat + tool-use + json-mode for the deepseek-v4 family", () => {
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-0813"]) {
      const caps = provider.inferCapabilities(model(id));
      expect(caps).toContain("text.generation");
      expect(caps).toContain("tool-use");
      expect(caps).toContain("json-mode");
      expect(caps).toContain("model.count-tokens");
    }
  });

  it("never infers vision-input or image.generation (the chat models are text-only)", () => {
    const caps = provider.inferCapabilities(model("deepseek-v4-pro"));
    expect(caps).not.toContain("vision-input");
    expect(caps).not.toContain("image.generation");
  });

  it("falls back to declared capabilities when the model id is unknown", () => {
    const caps = provider.inferCapabilities(
      model("totally-unknown-model", ["text.classification"])
    );
    expect(caps).toEqual(["text.classification"]);
  });

  it("falls back to a baseline of meta-ops when nothing matches and nothing is declared", () => {
    const caps = provider.inferCapabilities(model("totally-unknown-model"));
    expect(caps).toContain("model.search");
    expect(caps).toContain("model.info");
    expect(caps).not.toContain("text.generation");
  });

  it("infers the full capability set for deepseek-v4-flash", () => {
    const caps = provider.inferCapabilities(model("deepseek-v4-flash"));
    const sorted = [...caps].sort();
    expect(sorted).toEqual([
      "json-mode",
      "model.count-tokens",
      "model.info",
      "model.search",
      "text.generation",
      "text.rewriter",
      "text.summary",
      "tool-use",
    ]);
  });
});

describe("capability-set parity", () => {
  it("DEEPSEEK_RUN_FN_SPECS matches DEEPSEEK_RUN_FNS serves shapes", () => {
    const fnsServes = DEEPSEEK_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    const specsServes = DEEPSEEK_RUN_FN_SPECS.map((s) => [...s.serves].sort().join(","));
    expect(specsServes).toEqual(fnsServes);
  });
});

describe("DEEPSEEK_RUN_FNS shape", () => {
  it("registers a runFn for every capability set the provider claims to serve", () => {
    const sets = DEEPSEEK_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    expect(sets).toContain("text.generation");
    expect(sets).toContain("text.generation,tool-use");
    expect(sets).toContain("json-mode,text.generation");
    expect(sets).toContain("text.rewriter");
    expect(sets).toContain("text.summary");
    expect(sets).toContain("model.count-tokens");
    expect(sets).toContain("model.search");
    expect(sets).toContain("model.info");
  });

  it("tiebreaks `text.generation` to the smallest serves entry (plain text-gen)", () => {
    const candidates = DEEPSEEK_RUN_FNS.filter((r) => r.serves.includes("text.generation"));
    expect(candidates.some((r) => r.serves.length === 1)).toBe(true);
  });
});

describe("base URL", () => {
  it("defaults to the documented DeepSeek host, which is also the only allow-listed one", () => {
    expect(DEEPSEEK_DEFAULT_BASE_URL).toBe("https://api.deepseek.com");
    expect(DEEPSEEK_ALLOWED_HOSTS).toEqual(["api.deepseek.com"]);
    expect(DEEPSEEK_ALLOWED_HOSTS).toContain(new URL(DEEPSEEK_DEFAULT_BASE_URL).hostname);
  });
});

describe("resolveMaxTokens", () => {
  const thinkingModel = model("deepseek-v4-flash");

  it("adds the default reasoning allowance to the caller's answer budget", () => {
    expect(resolveMaxTokens(thinkingModel as never, 4096)).toBe(
      4096 + DEEPSEEK_DEFAULT_REASONING_ALLOWANCE
    );
  });

  it("returns undefined when the caller set no budget, leaving DeepSeek's own default", () => {
    expect(resolveMaxTokens(thinkingModel as never, undefined)).toBeUndefined();
  });

  it("honours a per-model reasoning_allowance override", () => {
    const configured = {
      ...thinkingModel,
      provider_config: { model_name: "deepseek-v4-flash", reasoning_allowance: 1000 },
    };
    expect(resolveMaxTokens(configured as never, 500)).toBe(1500);
  });

  it("allows a non-thinking model to opt out with an allowance of 0", () => {
    const nonThinking = {
      ...thinkingModel,
      provider_config: { model_name: "deepseek-chat", reasoning_allowance: 0 },
    };
    expect(resolveMaxTokens(nonThinking as never, 2048)).toBe(2048);
  });

  it("maps model.effort when reasoning_allowance is unset", () => {
    expect(resolveMaxTokens({ ...thinkingModel, effort: "none" } as never, 4096)).toBe(4096);
    expect(resolveMaxTokens({ ...thinkingModel, effort: "low" } as never, 4096)).toBe(4096 + 4096);
    expect(resolveMaxTokens({ ...thinkingModel, effort: "medium" } as never, 4096)).toBe(
      4096 + 8192
    );
    expect(resolveMaxTokens({ ...thinkingModel, effort: "high" } as never, 4096)).toBe(
      4096 + 16_384
    );
    expect(resolveMaxTokens({ ...thinkingModel, effort: "extra" } as never, 4096)).toBe(
      4096 + 24_576
    );
    expect(resolveMaxTokens({ ...thinkingModel, effort: "ultra" } as never, 4096)).toBe(
      4096 + 32_768
    );
  });

  // One function, two branches, and only one of them consulted the policy: a
  // model it had just declared has no reasoning was still paid the full default
  // allowance on top of the caller's budget, whether or not effort was set.
  it("pays no allowance on a model the policy says does not reason", () => {
    const nonThinking = {
      ...thinkingModel,
      provider_config: { model_name: "deepseek-chat" },
    };
    expect(resolveMaxTokens({ ...nonThinking, effort: "ultra" } as never, 4096)).toBe(4096);
    expect(resolveMaxTokens(nonThinking as never, 4096)).toBe(4096);
  });

  // `deepseek-reasoner` is the vendor's own name for the thinking model, and
  // the policy used to deny it — so the dial fell through to the flat default.
  it("maps model.effort on deepseek-reasoner", () => {
    const reasoner = {
      ...thinkingModel,
      provider_config: { model_name: "deepseek-reasoner" },
    };
    expect(resolveMaxTokens({ ...reasoner, effort: "low" } as never, 4096)).toBe(4096 + 4096);
    expect(resolveMaxTokens(reasoner as never, 4096)).toBe(
      4096 + DEEPSEEK_DEFAULT_REASONING_ALLOWANCE
    );
  });

  it("honours effort_options even when the class policy would allow the effort", () => {
    expect(
      resolveMaxTokens({ ...thinkingModel, effort: "ultra", effort_options: [] } as never, 4096)
    ).toBe(4096 + DEEPSEEK_DEFAULT_REASONING_ALLOWANCE);
  });

  it("lets reasoning_allowance win over model.effort", () => {
    const configured = {
      ...thinkingModel,
      effort: "ultra",
      provider_config: { model_name: "deepseek-v4-flash", reasoning_allowance: 1000 },
    };
    expect(resolveMaxTokens(configured as never, 500)).toBe(1500);
  });

  it("clamps a negative allowance rather than shrinking the answer budget", () => {
    const bogus = {
      ...thinkingModel,
      provider_config: { model_name: "deepseek-v4-flash", reasoning_allowance: -5000 },
    };
    expect(resolveMaxTokens(bogus as never, 2048)).toBe(2048);
  });
});

describe("reasoningParams", () => {
  const flash = (effort?: string) =>
    ({
      provider: "DEEPSEEK",
      provider_config: { model_name: "deepseek-flash" },
      ...(effort ? { effort } : {}),
    }) as never;

  it("sends the effort a caller set, in DeepSeek's names", () => {
    expect(reasoningParams(flash("low"))).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams(flash("high"))).toEqual({ reasoning_effort: "high" });
    expect(reasoningParams(flash("extra"))).toEqual({ reasoning_effort: "xhigh" });
    expect(reasoningParams(flash("ultra"))).toEqual({ reasoning_effort: "max" });
  });

  it("turns thinking off for none, which DeepSeek spells as its own switch", () => {
    expect(reasoningParams(flash("none"))).toEqual({ thinking: { type: "disabled" } });
  });

  it("sends nothing when no effort is set, or the model does not reason", () => {
    expect(reasoningParams(flash())).toEqual({});
    expect(
      reasoningParams({
        provider: "DEEPSEEK",
        provider_config: { model_name: "deepseek-chat" },
        effort: "high",
      } as never)
    ).toEqual({});
  });
});

describe("assertNotTruncatedByReasoning", () => {
  it("throws when the budget was exhausted before any content was emitted", () => {
    expect(() => assertNotTruncatedByReasoning("length", "", 4096)).toThrow(
      /exhausted its token budget on reasoning/
    );
  });

  it("names the knobs to turn", () => {
    expect(() => assertNotTruncatedByReasoning("length", "", 4096)).toThrow(
      /maxTokens.*reasoning_allowance/s
    );
  });

  it("stays silent on a truncated-but-non-empty response (partial beats an exception)", () => {
    expect(() => assertNotTruncatedByReasoning("length", '{"a":1', 4096)).not.toThrow();
  });

  it("stays silent on a normal completion", () => {
    expect(() => assertNotTruncatedByReasoning("stop", "", 4096)).not.toThrow();
    expect(() => assertNotTruncatedByReasoning(null, "", 4096)).not.toThrow();
  });
});
