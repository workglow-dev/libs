/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly } from "@workglow/huggingface-inference/ai";
import type { ScriptedReply } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

import { chatCompletionTurns, reasoningContentChunks } from "./chatCompletionsWire";

const { HFI_RUN_FNS, _setHfInferenceSDKForTesting } = _testOnly;

const model = {
  model_id: "hfi-conformance",
  provider: "HF_INFERENCE",
  provider_config: { model_name: "Qwen/Qwen3-32B", api_key: "test-key" },
} as never;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = HFI_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no HF Inference tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "HF Inference",
  createHarness: () => {
    const sent: unknown[] = [];
    const replies: ScriptedReply[] = [];
    /**
     * The SDK client the run-fn builds. `chatCompletionStream` hands its params
     * to the router as the request body, so they are what the router receives;
     * its stream yields the parsed chunks.
     */
    class ScriptedInferenceClient {
      chatCompletionStream(params: unknown): AsyncIterable<unknown> {
        sent.push(JSON.parse(JSON.stringify(params)));
        const chunks = reasoningContentChunks(replies.shift() ?? {});
        return (async function* () {
          yield* chunks;
        })();
      }
    }
    _setHfInferenceSDKForTesting({ InferenceClient: ScriptedInferenceClient } as never);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        toolCallingRunFn()(request as never, model, new AbortController().signal, emit as never),
      sent: () => sent,
      dispose: () => _setHfInferenceSDKForTesting(undefined),
    };
  },
  turns: chatCompletionTurns,
  reasoningStream: "reasoning-port",
  reasoningReplay: {
    kind: "none",
    reason:
      "the router forwards to whichever third-party provider serves the model, and " +
      "whether that backend reads a `reasoning_content` field on an input message, or " +
      "refuses it as unknown, varies by provider",
  },
  toolResultImages: { kind: "user-turn-after" },
});
