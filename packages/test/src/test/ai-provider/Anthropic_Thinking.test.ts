/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/anthropic/ai";
import { getLogger } from "@workglow/util";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildAnthropicThinkingParams,
  applyAnthropicThinkingParams,
  anthropicSupportsAdaptiveThinking,
} = _testOnly;

function model(opts: {
  model_name: string;
  effort?: string;
  effort_options?: readonly string[];
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
}) {
  return {
    provider: "ANTHROPIC",
    effort: opts.effort,
    effort_options: opts.effort_options,
    provider_config: {
      model_name: opts.model_name,
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.output_config ? { output_config: opts.output_config } : {}),
    },
  } as never;
}

describe("anthropicSupportsAdaptiveThinking", () => {
  it("is true for Claude 4.6+ and 5.x", () => {
    expect(anthropicSupportsAdaptiveThinking(model({ model_name: "claude-sonnet-4-6" }))).toBe(
      true
    );
    expect(anthropicSupportsAdaptiveThinking(model({ model_name: "claude-sonnet-5" }))).toBe(true);
  });

  it("is false for Claude 4.5 and unrecognized ids", () => {
    expect(anthropicSupportsAdaptiveThinking(model({ model_name: "claude-haiku-4-5" }))).toBe(
      false
    );
    expect(anthropicSupportsAdaptiveThinking(model({ model_name: "not-a-claude" }))).toBe(false);
  });
});

describe("buildAnthropicThinkingParams", () => {
  it("omits thinking when effort is unset or none before Claude 5", () => {
    expect(buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-4-6" }), 4096)).toEqual({
      max_tokens: 4096,
    });
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-4-6", effort: "none" }), 4096)
    ).toEqual({ max_tokens: 4096 });
  });

  it.each([
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "us.anthropic.claude-opus-5-5-v1:0",
  ])("defaults an unset effort to adaptive at the model's own effort on %s", (name) => {
    expect(buildAnthropicThinkingParams(model({ model_name: name }), 4096)).toEqual({
      thinking: { type: "adaptive" },
      max_tokens: 4096,
    });
  });

  // Claude 5+ runs adaptive thinking when `thinking` is omitted, so "none"
  // sends the lowest setting the model accepts instead of nothing.
  it("sends the minimal thinking setting for an explicit none on Claude 5+", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-5", effort: "none" }), 4096)
    ).toEqual({ output_config: { effort: "low" }, max_tokens: 4096 });
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-5-5", effort: "none" }), 4096)
    ).toEqual({ thinking: { type: "between_tools" }, max_tokens: 4096 });
  });

  // The documented fallback for an id nothing parses is the legacy budget, and
  // it has to stay reachable from `model.effort`: a policy that denied whatever
  // the parser declined dropped the setting before this path could run.
  it("routes an unparsed id — a gateway spelling included — to the legacy budget", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "not-a-claude", effort: "high" }), 4096)
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
      max_tokens: 4096 + 2048,
    });
    expect(
      buildAnthropicThinkingParams(
        model({ model_name: "us.anthropic.claude-sonnet-4-20250514-v1:0", effort: "high" }),
        4096
      )
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
      max_tokens: 4096 + 2048,
    });
  });

  // Extended thinking arrived in Claude 3.7; sending any thinking field to an
  // older generation is a 400, so the policy denies the dial there.
  it("does not map model.effort on a generation that predates thinking", () => {
    expect(
      buildAnthropicThinkingParams(
        model({ model_name: "claude-3-5-haiku-20241022", effort: "high" }),
        4096
      )
    ).toEqual({ max_tokens: 4096 });
    expect(
      buildAnthropicThinkingParams(
        model({ model_name: "anthropic.claude-3-5-sonnet-20241022-v2:0", effort: "high" }),
        4096
      )
    ).toEqual({ max_tokens: 4096 });
  });

  it("honours effort_options even when the class policy would allow the effort", () => {
    expect(
      buildAnthropicThinkingParams(
        model({ model_name: "claude-sonnet-5", effort: "high", effort_options: [] }),
        4096
      )
    ).toEqual({ thinking: { type: "adaptive" }, max_tokens: 4096 });
  });

  it("maps high effort to adaptive on Claude 5", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-5", effort: "high" }), 1000)
    ).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      max_tokens: 1000 + 2048,
    });
  });

  it("maps high effort to budget_tokens on Claude 4.5", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-haiku-4-5", effort: "high" }), 1000)
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
      max_tokens: 1000 + 2048,
    });
  });

  it("maps extra/ultra onto adaptive xhigh/max", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-opus-5", effort: "extra" }), 500)
        .output_config
    ).toEqual({ effort: "xhigh" });
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-opus-5", effort: "ultra" }), 500)
        .output_config
    ).toEqual({ effort: "max" });
  });

  it("lets native provider_config.thinking win over effort", () => {
    expect(
      buildAnthropicThinkingParams(
        model({
          model_name: "claude-sonnet-5",
          effort: "ultra",
          thinking: { type: "enabled", budget_tokens: 100 },
        }),
        1000
      )
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 100 },
      max_tokens: 1100,
    });
  });

  it("lets native output_config.effort win over model.effort", () => {
    expect(
      buildAnthropicThinkingParams(
        model({
          model_name: "claude-sonnet-5",
          effort: "low",
          output_config: { effort: "max" },
        }),
        1000
      )
    ).toEqual({
      output_config: { effort: "max" },
      max_tokens: 1000,
    });
  });

  // Anthropic rejects a legacy budget below 1024 with a 400, and `low` maps to
  // 512. Before the clamp, `{model_name: "claude-haiku-4-5", effort: "low"}` —
  // an ordinary configuration — built a request the API always refused.
  it("clamps the legacy budget up to the 1024 minimum", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-haiku-4-5", effort: "low" }), 1000)
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
      max_tokens: 1000 + 1024,
    });
  });

  // Scope guard: on the adaptive path the same 512 is `max_tokens` headroom,
  // not a budget, so the minimum does not apply and must not be applied.
  it("does not clamp adaptive headroom", () => {
    expect(
      buildAnthropicThinkingParams(model({ model_name: "claude-sonnet-5", effort: "low" }), 1000)
    ).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      max_tokens: 1000 + 512,
    });
  });

  // Carve-out guard: a native `provider_config.thinking.budget_tokens` is an
  // explicit provider-level opt-in. Silently rewriting it would hide the
  // config error rather than surfacing it as the 400 it is.
  it("leaves a native sub-minimum budget alone", () => {
    expect(
      buildAnthropicThinkingParams(
        model({
          model_name: "claude-haiku-4-5",
          thinking: { type: "enabled", budget_tokens: 100 },
        }),
        1000
      )
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 100 },
      max_tokens: 1100,
    });
  });
});

describe("applyAnthropicThinkingParams — forced tool choice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseParams(toolChoice?: Record<string, unknown>): Record<string, unknown> {
    return { max_tokens: 1000, ...(toolChoice ? { tool_choice: toolChoice } : {}) };
  }

  it("merges thinking when no tool_choice is present", () => {
    const params = baseParams();
    applyAnthropicThinkingParams(params, model({ model_name: "claude-haiku-4-5", effort: "high" }));
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(params.max_tokens).toBe(1000 + 2048);
  });

  // A forced tool choice cannot carry legacy extended thinking. Before the
  // guard, a structured-generation request (which always forces
  // `{type:"tool"}`) on a thinking-configured legacy model sent both.
  it.each([[{ type: "tool", name: "structured_output" }], [{ type: "any" }]])(
    "omits legacy thinking under tool_choice %o",
    (toolChoice) => {
      vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
      const params = baseParams(toolChoice);
      applyAnthropicThinkingParams(
        params,
        model({ model_name: "claude-haiku-4-5", effort: "high" })
      );
      expect("thinking" in params).toBe(false);
      // max_tokens is left unpadded — there is no thinking budget to pad for.
      expect(params.max_tokens).toBe(1000);
    }
  );

  // `{type:"auto"}` is what mapAnthropicToolChoice produces by default, so a
  // naive "tool_choice is present" check would suppress thinking on nearly
  // every tool-calling request.
  it("does not treat tool_choice auto as forced", () => {
    const params = baseParams({ type: "auto" });
    applyAnthropicThinkingParams(params, model({ model_name: "claude-haiku-4-5", effort: "high" }));
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  // Over-suppression guard: the constraint is on legacy `enabled` thinking.
  // Adaptive thinking on 4.6+ is unaffected and must survive a forced choice.
  it("keeps adaptive thinking under a forced tool choice", () => {
    const params = baseParams({ type: "tool", name: "structured_output" });
    applyAnthropicThinkingParams(params, model({ model_name: "claude-sonnet-5", effort: "high" }));
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
  });

  // The guard reads the built result, not the model version, so a native
  // provider_config.thinking on a modern id is covered too.
  it("omits a native enabled thinking under a forced tool choice", () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const params = baseParams({ type: "any" });
    applyAnthropicThinkingParams(
      params,
      model({ model_name: "claude-sonnet-5", thinking: { type: "enabled", budget_tokens: 2048 } })
    );
    expect("thinking" in params).toBe(false);
  });
});
