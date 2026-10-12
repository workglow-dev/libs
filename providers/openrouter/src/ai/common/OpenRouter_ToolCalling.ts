/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
} from "@workglow/ai";
import {
  accumulateOpenAIChatStream,
  buildOpenAITools,
  mapOpenAIToolChoice,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import { getClient, getModelName } from "./OpenRouter_Client";
import type { OpenRouterModelConfig } from "./OpenRouter_ModelSchema";
import { buildOpenRouterExtras } from "./OpenRouter_RequestParams";
import {
  createReasoningDetailAccumulator,
  encodeReasoningTurn,
  mergeReasoningDetailDelta,
  withReasoningDetails,
} from "./OpenRouter_ReasoningDetails";
import type { ReasoningDetailAccumulator } from "./OpenRouter_ReasoningDetails";
import { mapOpenRouterUsage } from "./OpenRouter_Usage";

/** The readable text of a chunk's reasoning details: `reasoning.text` and summaries. */
function detailText(details: readonly unknown[]): string {
  return details
    .map((detail) => {
      // A malformed entry is skipped, as the accumulator skips it.
      if (detail === null || typeof detail !== "object") return "";
      const d = detail as { type?: unknown; text?: unknown; summary?: unknown };
      if (d.type === "reasoning.text" && typeof d.text === "string") return d.text;
      if (d.type === "reasoning.summary" && typeof d.summary === "string") return d.summary;
      return "";
    })
    .join("");
}

/**
 * Passes the stream through while collecting each chunk's `reasoning_details`.
 * A chunk whose thinking arrives only there, with no `reasoning` of its own,
 * gets that text as `reasoning`, so it reaches the reasoning port as well as
 * the replay; one that carries both is left alone, so nothing is said twice.
 */
async function* tapReasoningDetails(
  stream: AsyncIterable<any>,
  acc: ReasoningDetailAccumulator
): AsyncGenerator<any> {
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta;
    const details = delta?.reasoning_details;
    if (!Array.isArray(details)) {
      yield chunk;
      continue;
    }
    mergeReasoningDetailDelta(acc, details);
    const text = detailText(details);
    if (text && !delta.reasoning && !delta.reasoning_content) {
      yield {
        ...chunk,
        choices: [
          { ...chunk.choices[0], delta: { ...delta, reasoning: text } },
          ...chunk.choices.slice(1),
        ],
      };
      continue;
    }
    yield chunk;
  }
}

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Forwards deltas via
 * {@link accumulateOpenAIChatStream}; each tool-call delta is filtered against
 * `input.tools` so a hallucinated function name never reaches the consumer.
 */
export const OpenRouter_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  OpenRouterModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const tools = buildOpenAITools(input.tools);
  // The details are readable only by the model that wrote them, so the native
  // turn is keyed by model and another model gets the rebuilt turn.
  const nativeKey = `openrouter:${modelName}`;
  const messages = withReasoningDetails(
    toOpenAIMessages(input, { toolImagesInUserMessage: true }),
    input.messages,
    nativeKey
  );
  const toolChoice = mapOpenAIToolChoice(input.toolChoice, true);

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages,
      max_completion_tokens: input.maxTokens,
      temperature: input.temperature,
      stream: true,
      tools,
      tool_choice: toolChoice,
      ...buildOpenRouterExtras(model),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  const details = createReasoningDetailAccumulator();
  // The calls this round actually emitted, in order, each as last streamed: the
  // replay is valid only beside the same calls.
  const emittedCalls = new Map<string, ToolCalls[number]>();
  // Whether each call the model made survived validation, as last streamed. The
  // details were produced beside every call, so a turn missing one of them is
  // not the turn they belong to and is not replayed.
  const callKept = new Map<string, boolean>();
  const usage = await accumulateOpenAIChatStream(
    tapReasoningDetails(stream, details),
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const calls = event.objectDelta as ToolCalls;
        const validated = filterValidToolCalls(calls, input.tools);
        const kept = new Set(validated.map((call) => call.id));
        for (const call of calls) callKept.set(call.id, kept.has(call.id));
        if (validated.length > 0) {
          for (const call of validated) emittedCalls.set(call.id, call);
          emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
        }
        return;
      }
      emit(event);
    },
    mapOpenRouterUsage,
    {
      promptText: messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n"),
    }
  );
  const items = details.items();
  const dropped = [...callKept.values()].some((isKept) => !isKept);
  const payload =
    items === undefined || dropped
      ? undefined
      : encodeReasoningTurn([...emittedCalls.values()], items);
  if (payload !== undefined) {
    emit({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: nativeKey, payload },
    });
  }
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
