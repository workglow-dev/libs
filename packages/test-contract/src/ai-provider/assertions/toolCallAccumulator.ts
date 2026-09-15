/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCalls, ToolDefinition } from "@workglow/ai";
import { toolCalling } from "@workglow/ai";
import { parsePartialJson } from "@workglow/util/schema";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts, ConformanceFixture } from "../types";

export function toolCallAccumulatorBlock(
  opts: AiProviderConformanceOpts,
  fixture: ConformanceFixture
): void {
  const enabled = opts.capabilities.tools && !!opts.models.toolCalling;
  describe.skipIf(!enabled)("Tool-call accumulator", () => {
    it(
      "produces ≥1 call with non-empty id, expected name, and parsable final args",
      async () => {
        // NOTE: This test only inspects the *final* tool-call result. Validating
        // intermediate stream-delta stability (id constant across object-deltas,
        // parsePartialJson at every intermediate step) requires driving the
        // streamFn directly and is tracked as a follow-up enhancement.
        const tool: ToolDefinition = {
          name: fixture.weatherTool.name,
          description: fixture.weatherTool.description,
          inputSchema: fixture.weatherTool.inputSchema,
        };
        const result = await toolCalling({
          model: opts.models.toolCalling!,
          prompt: fixture.weatherToolPrompt,
          tools: [tool],
          toolChoice: "required",
          maxTokens: fixture.maxTokens,
          messages: undefined,
        });
        const calls: ToolCalls = result.toolCalls;
        expect(calls.length).toBeGreaterThan(0);
        const call = calls[0];
        expect(call.name).toBe(fixture.weatherTool.name);
        expect(call.id).toBeTruthy();
        expect(call.input).toBeDefined();

        // Final args, when serialized, must round-trip through parsePartialJson.
        const serialized = typeof call.input === "string" ? call.input : JSON.stringify(call.input);
        const parsed = parsePartialJson(serialized);
        expect(parsed).toBeDefined();
      },
      opts.timeout
    );

    it(
      "produces no tool calls with toolChoice none",
      async () => {
        const tool: ToolDefinition = {
          name: fixture.weatherTool.name,
          description: fixture.weatherTool.description,
          inputSchema: fixture.weatherTool.inputSchema,
        };
        const result = await toolCalling({
          model: opts.models.toolCalling!,
          prompt: fixture.weatherToolPrompt,
          tools: [tool],
          toolChoice: "none",
          maxTokens: fixture.maxTokens,
          messages: undefined,
        });
        expect(result).toBeDefined();
        expect(typeof result.text).toBe("string");
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.toolCalls).toHaveLength(0);
      },
      opts.timeout
    );
  });
}
