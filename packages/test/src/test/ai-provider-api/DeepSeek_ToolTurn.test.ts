/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly } from "@workglow/deepseek/ai";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { asText } from "@workglow/util";
import { vi } from "vitest";

import { chatCompletionTurns, reasoningContentChunks, sseResponse } from "./chatCompletionsWire";

const model = {
  model_id: "deepseek-conformance",
  provider: "DEEPSEEK",
  provider_config: { model_name: "deepseek-reasoner", api_key: "test-key" },
} as never;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = _testOnly.DEEPSEEK_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no DeepSeek tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "DeepSeek",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    // DeepSeek is reached through the `openai` SDK, which posts with the global fetch.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseResponse(reasoningContentChunks(replies.shift() ?? {})));
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
  // `reasoning_content` on every assistant turn: the thinking models read it back
  // in a tool-calling loop. `provider_config.replay_reasoning: false` turns it off.
  reasoningReplay: { kind: "text" },
  toolResultImages: {
    kind: "text-only",
    reason: "DeepSeek's chat models read text only, so the result names the image in its place",
  },
});
