/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { toOllamaMessages } from "../../../../../providers/ollama/src/ai/common/Ollama_Messages";
import { createOllamaToolCallingStream } from "../../../../../providers/ollama/src/ai/common/Ollama_ToolCalling";

import { chatCompletionTurns } from "./chatCompletionsWire";

const model = {
  provider: "OLLAMA",
  provider_config: { model_name: "qwen3:8b" },
  effort: "medium",
} as never;

/** The reply as Ollama's `/api/chat` streams it: `thinking`, then content, then calls. */
function ollamaChunks(reply: ScriptedReply): unknown[] {
  const chunks: unknown[] = [];
  if (reply.reasoning !== undefined) {
    chunks.push({ message: { role: "assistant", content: "", thinking: reply.reasoning } });
  }
  if (reply.text !== undefined)
    chunks.push({ message: { role: "assistant", content: reply.text } });
  chunks.push({
    message: {
      role: "assistant",
      content: "",
      ...(reply.toolCalls?.length
        ? {
            tool_calls: reply.toolCalls.map((call) => ({
              function: { name: call.name, arguments: call.input },
            })),
          }
        : {}),
    },
    done: true,
  });
  return chunks;
}

runToolTurnConformance({
  name: "Ollama",
  createHarness: () => {
    const sent: unknown[] = [];
    const replies: ScriptedReply[] = [];
    const chat = async (request: unknown): Promise<AsyncIterable<unknown>> => {
      sent.push(JSON.parse(JSON.stringify(request)));
      const chunks = ollamaChunks(replies.shift() ?? {});
      async function* stream(): AsyncGenerator<unknown> {
        yield* chunks;
      }
      return Object.assign(stream(), { abort() {} });
    };
    const runFn = createOllamaToolCallingStream(async () => ({ chat }) as never, toOllamaMessages);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        runFn(request as never, model, new AbortController().signal, emit as never),
      sent: () => sent,
      dispose: () => {},
    };
  },
  turns: chatCompletionTurns,
  reasoningStream: "reasoning-port",
  reasoningReplay: { kind: "text" },
  toolResultImages: { kind: "user-turn-after" },
});
