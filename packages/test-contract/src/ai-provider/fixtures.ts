/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JsonSchema } from "@workglow/util/schema";
import type { ConformanceFixture } from "./types";

export const DEFAULT_CONFORMANCE_FIXTURE: ConformanceFixture = {
  textPrompt: "Say hello in one short sentence.",
  weatherTool: {
    name: "get_weather",
    description: "Get the current weather for a given city.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name, e.g. San Francisco" },
      },
      required: ["location"],
    } as const satisfies JsonSchema,
  },
  weatherToolPrompt: "What is the weather in San Francisco?",
  multiTurnTranscript: [
    { role: "user", text: "What is the weather in Tokyo?" },
    { role: "assistant", text: "Let me check." },
    { role: "tool", text: '{"temperature":22,"conditions":"sunny"}' },
  ],
  structuredSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
    additionalProperties: false,
  } as const satisfies JsonSchema,
  structuredPrompt:
    "Generate a JSON object with a person's name and age. Use name 'Alice' and age 30.",
  maxTokens: 100,
  abortGraceMs: 50,
};

export function resolveFixture(
  override: Partial<ConformanceFixture> | undefined
): ConformanceFixture {
  if (!override) return DEFAULT_CONFORMANCE_FIXTURE;
  return { ...DEFAULT_CONFORMANCE_FIXTURE, ...override };
}
