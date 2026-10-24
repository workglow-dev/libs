/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly, LOCAL_LLAMACPP } from "@workglow/node-llama-cpp/ai";
import { llamaCppTextContexts } from "@workglow/node-llama-cpp/ai-runtime";
import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import { vi } from "vitest";

/**
 * The scripted SDK's state. `generateResponse` is handed the chat history the
 * run-fn built, which the chat wrapper renders into the model's template: it is
 * the request.
 */
const script = vi.hoisted(() => ({
  sent: [] as unknown[],
  replies: [] as Array<{
    readonly reasoning?: string | undefined;
    readonly text?: string | undefined;
    readonly toolCalls?:
      | ReadonlyArray<{ readonly name: string; readonly input: Readonly<Record<string, unknown>> }>
      | undefined;
  }>,
}));

vi.mock("node-llama-cpp", () => {
  const fakeContext = {
    get sequencesLeft() {
      return 4;
    },
    getSequence() {
      return { nextTokenIndex: 0, dispose: async () => {} };
    },
    dispose: async () => {},
  };
  return {
    getLlama: async () => ({
      loadModel: async () => ({ createContext: async () => fakeContext }),
    }),
    LlamaChatSession: class {},
    /**
     * Streams the scripted reply as node-llama-cpp does: a thought segment,
     * then the main response (untyped chunks), then the parsed calls on the
     * result.
     */
    LlamaChat: class {
      async generateResponse(
        history: unknown[],
        options: {
          readonly onResponseChunk?: (chunk: {
            readonly type?: string;
            readonly segmentType?: string;
            readonly text: string;
          }) => void;
        }
      ): Promise<unknown> {
        script.sent.push(JSON.parse(JSON.stringify(history)));
        const reply = script.replies.shift() ?? {};
        if (reply.reasoning !== undefined) {
          options.onResponseChunk?.({
            type: "segment",
            segmentType: "thought",
            text: reply.reasoning,
          });
        }
        if (reply.text !== undefined) options.onResponseChunk?.({ text: reply.text });
        return {
          functionCalls: (reply.toolCalls ?? []).map((call) => ({
            functionName: call.name,
            params: call.input,
          })),
          lastEvaluation: { cleanHistory: history },
        };
      }
      dispose(): void {}
    },
  };
});

const model = {
  model_id: "llamacpp:tool-turn-conformance",
  title: "tool turn conformance",
  description: "",
  capabilities: ["text.generation", "tool-use"],
  provider: LOCAL_LLAMACPP,
  provider_config: { model_path: "/tmp/tool-turn-conformance.gguf" },
  metadata: {},
} as never;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = _testOnly.LLAMACPP_RUN_FNS.find(
    ({ serves }) =>
      [...serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
  );
  if (!registration) throw new Error("no node-llama-cpp tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

interface HistoryItem {
  readonly type: "system" | "user" | "model";
  readonly response?: ReadonlyArray<unknown>;
}

/**
 * node-llama-cpp's history has no tool turn: a call's result is set on the
 * `functionCall` item inside the model response that made it, and the chat
 * wrapper renders it as the template's tool turn after that call. So a model
 * response is read as the assistant turn up to each answered call, then that
 * call's result as a tool turn.
 */
function turns(request: unknown): WireTurn[] {
  const out: WireTurn[] = [];
  for (const item of request as ReadonlyArray<HistoryItem>) {
    if (item.type !== "model") {
      out.push({ role: item.type, body: item });
      continue;
    }
    let assistant: unknown[] = [];
    for (const entry of item.response ?? []) {
      const call = entry as { type?: unknown; name?: unknown; result?: unknown };
      if (call.type !== "functionCall" || call.result === undefined) {
        assistant.push(entry);
        continue;
      }
      const { result, ...made } = call;
      assistant.push(made);
      out.push({ role: "assistant", body: assistant });
      out.push({ role: "tool", body: { name: call.name, result } });
      assistant = [];
    }
    if (assistant.length > 0) out.push({ role: "assistant", body: assistant });
  }
  return out;
}

runToolTurnConformance({
  name: "node-llama-cpp",
  createHarness: () => {
    script.sent.length = 0;
    script.replies.length = 0;
    llamaCppTextContexts.clear();
    return {
      respond: (reply: ScriptedReply) => void script.replies.push(reply),
      run: (request, emit) =>
        toolCallingRunFn()(
          { ...request, toolChoice: "auto" } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () => script.sent,
      dispose: () => llamaCppTextContexts.clear(),
    };
  },
  turns,
  reasoningStream: "reasoning-port",
  // Each reasoning block goes back as an ended `thought` segment of its model response.
  reasoningReplay: { kind: "text" },
  toolResultImages: {
    kind: "text-only",
    reason:
      "a function call's result is a string in node-llama-cpp's chat history, so an " +
      "image is named there rather than sent",
  },
});
