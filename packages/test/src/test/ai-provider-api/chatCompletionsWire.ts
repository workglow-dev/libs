/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";

/** A chat-completions SSE body carrying `chunks`, then `[DONE]`. */
export function sseResponse(chunks: ReadonlyArray<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The turns of a chat-completions request body: its `messages`, each under its own role. */
export function chatCompletionTurns(request: unknown): WireTurn[] {
  const { messages } = request as { messages: Array<{ role: WireTurn["role"] }> };
  return messages.map((message) => ({ role: message.role, body: message }));
}

/**
 * A reply as an OpenAI-compatible server streams it when it reports its
 * thinking as `reasoning_content` (llama-server, DeepSeek, xAI's reasoning
 * models, the HF router's reasoning backends): the reasoning, then the content,
 * then every call in one delta, then the finish.
 */
export function reasoningContentChunks(reply: ScriptedReply): unknown[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
    id: "conformance",
    object: "chat.completion.chunk",
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
