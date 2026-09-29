/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/anthropic/ai";
import { describe, expect, it } from "vitest";

const { anthropicSupportsOutputFormat, toAnthropicOutputSchema } = _testOnly;

function model(modelName: string) {
  return { provider: "ANTHROPIC", provider_config: { model_name: modelName } } as never;
}

describe("anthropicSupportsOutputFormat", () => {
  it.each([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "us.anthropic.claude-opus-5-5-v1:0",
    "claude-opus-6",
  ])("supports %s", (id) => {
    expect(anthropicSupportsOutputFormat(model(id))).toBe(true);
  });

  it.each([
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-3-5-sonnet-20241022",
    "not-a-claude-id",
  ])("keeps the tool route on %s", (id) => {
    expect(anthropicSupportsOutputFormat(model(id))).toBe(false);
  });
});

describe("toAnthropicOutputSchema", () => {
  it("closes every object and drops constraints the decoder does not take", () => {
    expect(
      toAnthropicOutputSchema({
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, format: "email" },
          score: { type: "number", minimum: 0, maximum: 1 },
          tags: { type: "array", items: { type: "object", properties: {} }, minItems: 2 },
          kind: { oneOf: [{ const: "a" }, { const: "b" }] },
          when: { type: "string", format: "not-a-format" },
        },
        required: ["name"],
      })
    ).toEqual({
      type: "object",
      properties: {
        name: { type: "string", format: "email" },
        score: { type: "number" },
        tags: {
          type: "array",
          items: { type: "object", properties: {}, additionalProperties: false },
        },
        kind: { anyOf: [{ const: "a" }, { const: "b" }] },
        when: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("copies literal values as written, even when they look like keywords", () => {
    const schema = { type: "object", properties: { v: { const: { minimum: 3 } } } };
    expect(
      (toAnthropicOutputSchema(schema)!.properties as Record<string, { const: unknown }>).v.const
    ).toEqual({ minimum: 3 });
  });

  it("closes objects under nullable type arrays", () => {
    expect(toAnthropicOutputSchema({ type: ["object", "null"], properties: {} })).toEqual({
      type: ["object", "null"],
      properties: {},
      additionalProperties: false,
    });
  });

  it.each([
    ["a map-shaped object", { type: "object", additionalProperties: { type: "number" } }],
    ["pattern properties", { type: "object", patternProperties: { "^x": {} } }],
    ["a conditional", { type: "object", if: {}, then: {} }],
    [
      "a recursive $ref",
      {
        type: "object",
        properties: { node: { $ref: "#/$defs/node" } },
        $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
      },
    ],
  ])("refuses %s, leaving it to the tool route", (_label, schema) => {
    expect(toAnthropicOutputSchema(schema)).toBeUndefined();
  });

  it("accepts a $ref that does not loop", () => {
    const out = toAnthropicOutputSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/leaf" }, b: { $ref: "#/$defs/leaf" } },
      $defs: { leaf: { type: "string", maxLength: 3 } },
    });
    expect(out?.$defs).toEqual({ leaf: { type: "string" } });
  });
});
