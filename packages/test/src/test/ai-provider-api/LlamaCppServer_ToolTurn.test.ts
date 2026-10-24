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

import { chatCompletionTurns, reasoningContentChunks, sseResponse } from "./chatCompletionsWire";

const model = {
  provider: "LLAMACPP_SERVER",
  provider_config: { base_url: "http://localhost:8080", model_name: "m" },
} as never;

runToolTurnConformance({
  name: "llama.cpp server",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseResponse(reasoningContentChunks(replies.shift() ?? {})));
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
