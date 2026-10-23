/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WireTurn } from "@workglow/test-contract/ai-provider";

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
