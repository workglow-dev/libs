/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { OPENAI, _testOnly } from "@workglow/openai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/openai/ai-runtime";
import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

const { OPENAI_RUN_FNS, setOpenAIClientForTests } = _testOnly;

const MODEL_NAME = "gpt-5.5";

const model = {
  model_id: MODEL_NAME,
  title: MODEL_NAME,
  description: "",
  provider: OPENAI,
  provider_config: { model_name: MODEL_NAME, api_key: "test-key", reasoning: { effort: "high" } },
  capabilities: ["text.generation", "tool-use"],
  metadata: {},
} as never;

/**
 * The reply as the Responses API streams it with encrypted reasoning asked
 * for: a reasoning item carrying its summary and `encrypted_content`, a message
 * item, then each function call, each item finished by `output_item.done`.
 */
function responsesEvents(reply: ScriptedReply): unknown[] {
  const events: unknown[] = [];
  let outputIndex = 0;
  if (reply.reasoning !== undefined) {
    events.push(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: outputIndex,
        delta: reply.reasoning,
      },
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: reply.reasoning }],
          encrypted_content: "ENCRYPTED",
        },
      }
    );
    outputIndex++;
  }
  if (reply.text !== undefined) {
    events.push(
      { type: "response.output_text.delta", output_index: outputIndex, delta: reply.text },
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply.text, annotations: [] }],
        },
      }
    );
    outputIndex++;
  }
  for (const call of reply.toolCalls ?? []) {
    const item = {
      type: "function_call",
      id: `fc_${outputIndex}`,
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
    };
    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, arguments: "" },
      },
      { type: "response.output_item.done", output_index: outputIndex, item }
    );
    outputIndex++;
  }
  events.push({ type: "response.completed", response: {} });
  return events;
}

function turns(request: unknown): WireTurn[] {
  const { instructions, input } = request as {
    instructions?: unknown;
    input: Array<{ role?: string; type?: string }>;
  };
  const out: WireTurn[] =
    instructions === undefined ? [] : [{ role: "system", body: instructions }];
  for (const item of input) {
    const role: WireTurn["role"] =
      item.type === "function_call_output"
        ? "tool"
        : item.role === "user" || item.role === "system" || item.role === "assistant"
          ? item.role
          : item.role === "developer"
            ? "system"
            : // reasoning and function_call items are the model's own
              "assistant";
    out.push({ role, body: item });
  }
  return out;
}

function toolCallingRunFn(): AiProviderRunFn {
  const registration = OPENAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  if (!registration) throw new Error("no OpenAI tool-calling run-fn registered");
  return registration.runFn as AiProviderRunFn;
}

runToolTurnConformance({
  name: "OpenAI",
  createHarness: () => {
    const sent: unknown[] = [];
    const replies: ScriptedReply[] = [];
    const fakeClient = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          sent.push(JSON.parse(JSON.stringify(params)));
          const events = responsesEvents(replies.shift() ?? {});
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
          };
        },
      },
    };
    setOpenAIClientForTests(fakeClient);
    runtimeTestOnly.setOpenAIClientForTests(fakeClient);
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
        setOpenAIClientForTests(undefined);
        runtimeTestOnly.setOpenAIClientForTests(undefined);
      },
    };
  },
  turns,
  reasoningStream: {
    notForwarded:
      "the Responses adapter ignores reasoning-summary events, so a summary reaches no port",
  },
  reasoningReplay: {
    kind: "native",
    vendor: "openai",
    model: MODEL_NAME,
    wireForm: (payload) => JSON.parse(payload),
  },
  toolResultImages: { kind: "user-turn-after" },
});
