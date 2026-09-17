/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_EFFORTS } from "@workglow/ai";
import { ANTHROPIC, anthropicEffortPolicy } from "@workglow/anthropic/ai";
import { DEEPSEEK, deepseekEffortPolicy } from "@workglow/deepseek/ai";
import { geminiEffortPolicy, GOOGLE_GEMINI } from "@workglow/google-gemini/ai";
import { OPENROUTER, openrouterEffortPolicy } from "@workglow/openrouter/ai";
import { describe, expect, it } from "vitest";

function cfg(provider: string, model_name: string) {
  return { provider, provider_config: { model_name } };
}

describe("anthropicEffortPolicy", () => {
  it("treats parsed Claude ids as all six with default none", () => {
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "claude-sonnet-5"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "none",
    });
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "claude-3-7-sonnet-20250219"))?.default).toBe(
      "none"
    );
  });

  // The gateway spellings reach this provider through the `baseURL` seam. They
  // do not parse as native ids, and denying whatever the parser declined took
  // the dial away from them silently.
  it("keeps the dial on gateway-prefixed spellings of a thinking generation", () => {
    expect(
      anthropicEffortPolicy(cfg(ANTHROPIC, "us.anthropic.claude-sonnet-4-20250514-v1:0"))?.supported
    ).toEqual([...MODEL_EFFORTS]);
    expect(
      anthropicEffortPolicy(cfg(ANTHROPIC, "global.anthropic.claude-opus-4-1@20250805"))?.supported
    ).toEqual([...MODEL_EFFORTS]);
  });

  // An id nothing recognizes is likelier a spelling this package has not seen
  // than a model without thinking, and the legacy `thinking.type = "enabled"`
  // path already handles it — so it keeps the dial rather than losing it.
  it("keeps the dial on an unrecognized id, and on a model with no id at all", () => {
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "not-claude"))?.supported).toEqual([
      ...MODEL_EFFORTS,
    ]);
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, ""))?.supported).toEqual([...MODEL_EFFORTS]);
  });

  // Extended thinking arrived in 3.7: everything below it 400s on a thinking
  // field, gateway spelling included.
  it("returns no levels for generations that predate extended thinking", () => {
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "claude-3-5-haiku-20241022"))?.supported).toEqual(
      []
    );
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "claude-3-haiku-20240307"))?.supported).toEqual([]);
    expect(anthropicEffortPolicy(cfg(ANTHROPIC, "claude-2.1"))?.supported).toEqual([]);
    expect(
      anthropicEffortPolicy(cfg(ANTHROPIC, "anthropic.claude-3-5-sonnet-20241022-v2:0"))?.supported
    ).toEqual([]);
  });
});

describe("geminiEffortPolicy", () => {
  it("treats text gemini models as all six with default none", () => {
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, "gemini-3.8-flash"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "none",
    });
  });

  it("returns no levels for embeddings and image models", () => {
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, "gemini-embedding-2"))?.supported).toEqual([]);
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, "imagen-4.0-generate-001"))?.supported).toEqual(
      []
    );
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, "gemini-3.1-flash-image"))?.supported).toEqual([]);
  });

  it("answers an unrecognized id and an absent one the same way", () => {
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, "palm-2"))?.supported).toEqual([]);
    expect(geminiEffortPolicy(cfg(GOOGLE_GEMINI, ""))?.supported).toEqual([]);
  });
});

describe("deepseekEffortPolicy", () => {
  it("treats the v4 family and deepseek-flash as all six with default high", () => {
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-v4-flash"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "high",
    });
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-flash"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "high",
    });
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-v5"))?.default).toBe("high");
  });

  // `deepseek-reasoner` is the vendor's own name for the thinking model, and
  // matching only `deepseek-v4` dropped the dial on it.
  it("treats deepseek-reasoner and the r-series as reasoning", () => {
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-reasoner"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "high",
    });
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-r1"))?.supported).toEqual([
      ...MODEL_EFFORTS,
    ]);
  });

  it("returns no levels for the non-thinking chat id, an unknown id, and an absent one", () => {
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-chat"))?.supported).toEqual([]);
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, "deepseek-v3"))?.supported).toEqual([]);
    expect(deepseekEffortPolicy(cfg(DEEPSEEK, ""))?.supported).toEqual([]);
  });
});

describe("openrouterEffortPolicy", () => {
  // OpenRouter's catalogue is open-ended and it drops a parameter the routed
  // model does not take, so an unrecognized id keeps every level.
  it("returns all levels for text ids, including ones it does not recognize", () => {
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "openai/gpt-5"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: undefined,
    });
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "openai/gpt-4o"))?.supported).toEqual([
      ...MODEL_EFFORTS,
    ]);
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "newvendor/unheard-of"))?.supported).toEqual([
      ...MODEL_EFFORTS,
    ]);
    expect(openrouterEffortPolicy(cfg(OPENROUTER, ""))?.supported).toEqual([...MODEL_EFFORTS]);
  });

  // Returning every level unconditionally made the gate at the call site a
  // no-op: an embedding id has no `reasoning` field to carry the dial.
  it("returns no levels for the non-text modalities", () => {
    expect(
      openrouterEffortPolicy(cfg(OPENROUTER, "openai/text-embedding-3-small"))?.supported
    ).toEqual([]);
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "qwen/qwen3-embedding-8b"))?.supported).toEqual(
      []
    );
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "mistralai/mistral-embed"))?.supported).toEqual(
      []
    );
    expect(
      openrouterEffortPolicy(cfg(OPENROUTER, "black-forest-labs/flux-1.1-pro"))?.supported
    ).toEqual([]);
    expect(
      openrouterEffortPolicy(cfg(OPENROUTER, "google/gemini-2.5-flash-image"))?.supported
    ).toEqual([]);
    expect(openrouterEffortPolicy(cfg(OPENROUTER, "openai/whisper-1"))?.supported).toEqual([]);
    expect(
      openrouterEffortPolicy(cfg(OPENROUTER, "openai/omni-moderation-latest"))?.supported
    ).toEqual([]);
  });
});
