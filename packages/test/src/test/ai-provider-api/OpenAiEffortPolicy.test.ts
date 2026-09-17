/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_EFFORTS } from "@workglow/ai";
import { OPENAI, openaiEffortPolicy } from "@workglow/openai/ai";
import { describe, expect, it } from "vitest";

function cfg(model_name: string) {
  return { provider: OPENAI, provider_config: { model_name } };
}

describe("openaiEffortPolicy", () => {
  // OpenAI 400s on `reasoning` for the chat models that do not take it, so an
  // id this list does not place answers the same way an absent one does.
  it("returns no levels for an unrecognized id and for an absent one", () => {
    expect(openaiEffortPolicy({ provider: OPENAI, provider_config: { model_name: "" } })).toEqual({
      supported: [],
      default: undefined,
    });
    expect(openaiEffortPolicy(cfg("babbage-002"))?.supported).toEqual([]);
  });

  it("treats gpt-5, gpt-6, and o-series as reasoning with default medium", () => {
    expect(openaiEffortPolicy(cfg("gpt-5.6-sol"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "medium",
    });
    expect(openaiEffortPolicy(cfg("gpt-6-astra"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "medium",
    });
    expect(openaiEffortPolicy(cfg("o3-mini"))?.default).toBe("medium");
  });

  it("returns no levels for embeddings, image, and gpt-4o", () => {
    expect(openaiEffortPolicy(cfg("text-embedding-3-small"))?.supported).toEqual([]);
    expect(openaiEffortPolicy(cfg("gpt-image-2"))?.supported).toEqual([]);
    expect(openaiEffortPolicy(cfg("dall-e-3"))?.supported).toEqual([]);
    expect(openaiEffortPolicy(cfg("gpt-4o"))?.supported).toEqual([]);
  });
});
