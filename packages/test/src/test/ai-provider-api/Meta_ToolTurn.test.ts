/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly } from "@workglow/meta/ai";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { asText } from "@workglow/util";
import { vi } from "vitest";

import { chatCompletionTurns, reasoningContentChunks, sseResponse } from "./chatCompletionsWire";

const model = {
  model_id: "meta-conformance",
  provider: "META",
  provider_config: { model_name: "muse-spark-1.3", api_key: "test-key" },
} as never;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = _testOnly.META_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no Meta tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "Meta",
  createHarness: () => {
    const replies: ScriptedReply[] = [];
    // Meta is reached through the `openai` SDK, which posts with the global fetch.
    // The Muse models redact their reasoning on this surface; the script still
    // sends `reasoning_content` so the run-fn is held to keeping any it is given
    // off the `text` port.
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
      "Meta's chat completions redact reasoning before it reaches the caller and read none " +
      "back on an assistant turn; carrying reasoning across turns is a Responses-API feature",
  },
  toolResultImages: { kind: "user-turn-after" },
});
