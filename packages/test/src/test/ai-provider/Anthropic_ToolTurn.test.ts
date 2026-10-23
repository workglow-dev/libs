/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { ANTHROPIC, _testOnly } from "@workglow/anthropic/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/anthropic/ai-runtime";
import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

const { ANTHROPIC_RUN_FNS, setAnthropicClientForTests } = _testOnly;

const MODEL_NAME = "claude-sonnet-5-5";

const model = {
  model_id: MODEL_NAME,
  title: "",
  description: "",
  provider: ANTHROPIC,
  provider_config: { model_name: MODEL_NAME, api_key: "test-key" },
  capabilities: ["text.generation", "tool-use"],
  metadata: {},
} as never;

/** The reply as Anthropic streams it: signed thinking, then text, then each call. */
function anthropicEvents(reply: ScriptedReply): unknown[] {
  const events: unknown[] = [];
  let index = 0;
  if (reply.reasoning !== undefined) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: reply.reasoning },
      },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_stop", index }
    );
    index++;
  }
  if (reply.text !== undefined) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } },
      { type: "content_block_stop", index }
    );
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      },
      { type: "content_block_stop", index }
    );
    index++;
  }
  return events;
}

function turns(request: unknown): WireTurn[] {
  const { system, messages } = request as {
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
  };
  const out: WireTurn[] = system === undefined ? [] : [{ role: "system", body: system }];
  for (const message of messages) {
    const answersCalls =
      Array.isArray(message.content) &&
      message.content.some((block: { type?: string }) => block?.type === "tool_result");
    out.push({
      role: answersCalls ? "tool" : (message.role as WireTurn["role"]),
      body: message,
    });
  }
  return out;
}

function toolCallingRunFn(): AiProviderRunFn {
  const registration = ANTHROPIC_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  if (!registration) throw new Error("no Anthropic tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "Anthropic",
  createHarness: () => {
    const sent: unknown[] = [];
    const replies: ScriptedReply[] = [];
    const fakeClient = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          sent.push(JSON.parse(JSON.stringify(params)));
          const events = anthropicEvents(replies.shift() ?? {});
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
          };
        },
      },
    };
    setAnthropicClientForTests(fakeClient);
    runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        toolCallingRunFn()(
          { model, ...request } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () => sent,
      dispose: () => {
        setAnthropicClientForTests(undefined);
        runtimeTestOnly.setAnthropicClientForTests?.(undefined);
      },
    };
  },
  turns,
  reasoningStream: "reasoning-port",
  reasoningReplay: {
    kind: "native",
    vendor: "anthropic",
    model: MODEL_NAME,
    wireForm: (payload) => JSON.parse(payload),
  },
  toolResultImages: { kind: "in-result" },
});
