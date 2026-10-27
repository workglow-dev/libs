/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { asText } from "@workglow/util";
import { _testOnly } from "@workglow/xai/ai";
import { vi } from "vitest";

import { chatCompletionTurns, reasoningContentChunks, sseResponse } from "./chatCompletionsWire";

const model = {
  model_id: "xai-conformance",
  provider: "XAI",
  provider_config: { model_name: "grok-3-mini", api_key: "test-key" },
} as never;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = _testOnly.XAI_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no xAI tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "xAI",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    // xAI is reached through the `openai` SDK, which posts with the global fetch.
    // Grok's reasoning models stream their thinking as `reasoning_content`.
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
  reasoningReplay: {
    kind: "none",
    reason:
      "xAI's chat completions read no reasoning back on an assistant turn; Grok's " +
      "replayable (encrypted) reasoning exists only on the Responses API, which this adapter does not call",
  },
  toolResultImages: { kind: "user-turn-after" },
});
