/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCalls, ToolDefinition } from "@workglow/ai";
import { Workflow } from "@workglow/task-graph";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts, ConformanceFixture } from "../types";

export function toolCallMultiTurnBlock(
  opts: AiProviderConformanceOpts,
  fixture: ConformanceFixture
): void {
  const enabled = opts.capabilities.tools && !!opts.models.toolCalling;
  describe.skipIf(!enabled)("Tool-call multi-turn", () => {
    it(
      "second turn returns non-empty text after a tool result is provided",
      async () => {
        const tool: ToolDefinition = {
          name: fixture.weatherTool.name,
          description: fixture.weatherTool.description,
          inputSchema: fixture.weatherTool.inputSchema,
        };
        const wf1 = new Workflow();
        wf1.toolCalling({
          model: opts.models.toolCalling!,
          prompt: fixture.multiTurnTranscript[0].text,
          tools: [tool],
          toolChoice: "auto",
          maxTokens: fixture.maxTokens,
        });
        const r1 = (await wf1.run()) as { text: string; toolCalls: ToolCalls };
        if (!r1.toolCalls || r1.toolCalls.length === 0) return; // small models may skip the call
        const call = r1.toolCalls[0];

        const wf2 = new Workflow();
        wf2.toolCalling({
          model: opts.models.toolCalling!,
          prompt: fixture.multiTurnTranscript[0].text,
          tools: [tool],
          toolChoice: "auto",
          maxTokens: fixture.maxTokens,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: fixture.multiTurnTranscript[0].text }],
            },
            {
              role: "assistant",
              content: [
                { type: "text", text: r1.text || fixture.multiTurnTranscript[1].text },
                {
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.input,
                  // Round-trip the opaque provider signature (e.g. Gemini's
                  // thoughtSignature) — thinking models reject a replayed tool
                  // call whose signature was dropped.
                  providerSignature: call.providerSignature,
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: [{ type: "text" as const, text: fixture.multiTurnTranscript[2].text }],
                  is_error: undefined,
                },
              ],
            },
          ],
        });
        const r2 = (await wf2.run()) as { text: string };
        expect(typeof r2.text).toBe("string");
        expect(r2.text.length).toBeGreaterThan(0);
      },
      opts.timeout
    );
  });
}
