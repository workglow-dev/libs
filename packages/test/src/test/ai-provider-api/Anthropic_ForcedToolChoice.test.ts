/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/anthropic/ai";
import { describe, expect, it } from "vitest";

const { anthropicAcceptsForcedToolChoice } = _testOnly;

function model(modelName: string) {
  return { provider: "ANTHROPIC", provider_config: { model_name: modelName } } as never;
}

describe("anthropicAcceptsForcedToolChoice", () => {
  it.each([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "us.anthropic.claude-opus-5-5-v1:0",
    "claude-opus-6",
    "claude-haiku-5",
  ])("rejects on %s", (id) => {
    expect(anthropicAcceptsForcedToolChoice(model(id))).toBe(false);
  });

  it.each([
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-sonnet-4-20250514",
    "not-a-claude-id",
  ])("accepts on %s", (id) => {
    expect(anthropicAcceptsForcedToolChoice(model(id))).toBe(true);
  });
});
