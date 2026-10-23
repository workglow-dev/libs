/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { _testOnly } from "@workglow/google-gemini/ai";
import type {
  ScriptedReply,
  ToolResultImages,
  WireTurn,
} from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

const { GEMINI_RUN_FNS, setGeminiClientForTests } = _testOnly;

/**
 * The reply as Gemini streams it: thought-summary parts, then text, then each
 * call as a `functionCall` part carrying the `thoughtSignature` a thinking
 * model attaches to it. Gemini calls carry no id of their own.
 */
function geminiChunks(reply: ScriptedReply): unknown[] {
  const parts: unknown[] = [];
  if (reply.reasoning !== undefined) parts.push({ text: reply.reasoning, thought: true });
  if (reply.text !== undefined) parts.push({ text: reply.text });
  for (const call of reply.toolCalls ?? []) {
    parts.push({
      functionCall: { name: call.name, args: call.input },
      thoughtSignature: `signature-of-${call.id}`,
    });
  }
  return [{ candidates: [{ content: { role: "model", parts } }] }];
}

function turns(request: unknown): WireTurn[] {
  const { contents, config } = request as {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    config?: { systemInstruction?: unknown };
  };
  const out: WireTurn[] =
    config?.systemInstruction === undefined
      ? []
      : [{ role: "system", body: config.systemInstruction }];
  for (const content of contents) {
    const role: WireTurn["role"] =
      content.role === "model"
        ? "assistant"
        : content.parts.some((part) => part.functionResponse !== undefined)
          ? "tool"
          : "user";
    out.push({ role, body: content });
  }
  return out;
}

function toolCallingRunFn(): AiProviderRunFn {
  const registration = GEMINI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  if (!registration) throw new Error("no Gemini tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

function runGeminiToolTurnConformance(modelName: string, images: ToolResultImages): void {
  const model = {
    provider: "GOOGLE_GEMINI",
    provider_config: { api_key: "test-key", model_name: modelName },
  } as never;
  runToolTurnConformance({
    name: `Gemini (${modelName})`,
    createHarness: () => {
      const sent: unknown[] = [];
      const replies: ScriptedReply[] = [];
      setGeminiClientForTests({
        models: {
          generateContentStream: async (request: unknown) => {
            sent.push(JSON.parse(JSON.stringify(request)));
            const chunks = geminiChunks(replies.shift() ?? {});
            return {
              async *[Symbol.asyncIterator]() {
                yield* chunks;
              },
            };
          },
        },
      } as never);
      return {
        respond: (reply) => void replies.push(reply),
        run: (request, emit) =>
          toolCallingRunFn()(request as never, model, new AbortController().signal, emit as never),
        sent: () => sent,
        dispose: () => setGeminiClientForTests(undefined),
      };
    },
    turns,
    reasoningStream: "reasoning-port",
    reasoningReplay: { kind: "call-signature" },
    toolResultImages: images,
  });
}

// Gemini 3+ takes a tool's images inside its functionResponse; older models
// reject that with HTTP 400 and get them on a user turn of their own.
runGeminiToolTurnConformance("gemini-3-flash-preview", { kind: "in-result" });
runGeminiToolTurnConformance("gemini-2.5-flash", { kind: "user-turn-after" });
