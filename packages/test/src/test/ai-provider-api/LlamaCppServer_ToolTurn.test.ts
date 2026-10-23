/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLlamaCppServerToolCallingStream } from "@workglow/llamacpp-server/ai-runtime";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { asText } from "@workglow/util";
import { vi } from "vitest";

import { chatCompletionTurns, sseResponse } from "./chatCompletionsWire";

const model = {
  provider: "LLAMACPP_SERVER",
  provider_config: { base_url: "http://localhost:8080", model_name: "m" },
} as never;

/** The reply as llama-server streams it: `reasoning_content`, then content, then calls. */
function llamaServerChunks(reply: ScriptedReply): unknown[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const chunks: unknown[] = [];
  if (reply.reasoning !== undefined) chunks.push(chunk({ reasoning_content: reply.reasoning }));
  if (reply.text !== undefined) chunks.push(chunk({ content: reply.text }));
  const calls = reply.toolCalls ?? [];
  if (calls.length > 0) {
    chunks.push(
      chunk({
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      })
    );
  }
  chunks.push(chunk({}, calls.length > 0 ? "tool_calls" : "stop"));
  return chunks;
}

runToolTurnConformance({
  name: "llama.cpp server",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseResponse(llamaServerChunks(replies.shift() ?? {})));
    const runFn = createLlamaCppServerToolCallingStream({});
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        runFn(
          { ...request, toolChoice: "auto" } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () =>
        fetchSpy.mock.calls.map(([, init]) => JSON.parse(asText((init as RequestInit).body))),
      dispose: () => fetchSpy.mockRestore(),
    };
  },
  turns: chatCompletionTurns,
  reasoningStream: "reasoning-port",
  reasoningReplay: { kind: "text" },
  toolResultImages: { kind: "user-turn-after" },
});
