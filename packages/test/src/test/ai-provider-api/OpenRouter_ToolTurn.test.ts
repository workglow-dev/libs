/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly } from "@workglow/openrouter/ai";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { asText } from "@workglow/util";
import { vi } from "vitest";

import { chatCompletionTurns, sseResponse } from "./chatCompletionsWire";

const MODEL_NAME = "anthropic/claude-sonnet-5-5";

const model = {
  model_id: "openrouter-conformance",
  provider: "OPENROUTER",
  provider_config: { model_name: MODEL_NAME, api_key: "test-key" },
} as never;

/**
 * The reply as OpenRouter streams it: the thinking as signed
 * `reasoning_details`, then the content, then each call.
 */
function openRouterChunks(reply: ScriptedReply): unknown[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const chunks: unknown[] = [];
  if (reply.reasoning !== undefined) {
    chunks.push(
      chunk({
        reasoning_details: [
          {
            type: "reasoning.text",
            index: 0,
            format: "anthropic-claude-v1",
            text: reply.reasoning,
            signature: "SIG",
          },
        ],
      })
    );
  }
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

function toolCallingRunFn(): AiProviderRunFn {
  const registration = _testOnly.OPENROUTER_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no OpenRouter tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "OpenRouter",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseResponse(openRouterChunks(replies.shift() ?? {})));
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        toolCallingRunFn()(request as never, model, new AbortController().signal, emit as never),
      sent: () =>
        fetchSpy.mock.calls.map(([, init]) => JSON.parse(asText((init as RequestInit).body))),
      dispose: () => fetchSpy.mockRestore(),
    };
  },
  turns: chatCompletionTurns,
  reasoningStream: "reasoning-port",
  reasoningReplay: {
    kind: "native",
    vendor: "openrouter",
    model: MODEL_NAME,
    wireForm: (payload) => (JSON.parse(payload) as { details: unknown }).details,
  },
  toolResultImages: { kind: "user-turn-after" },
});
