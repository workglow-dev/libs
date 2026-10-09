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
  mergeReasoningDetailDelta,
  withReasoningDetails,
} from "./OpenRouter_ReasoningDetails";
import type { ReasoningDetailAccumulator } from "./OpenRouter_ReasoningDetails";
import { mapOpenRouterUsage } from "./OpenRouter_Usage";

/** Passes the stream through while collecting each chunk's `reasoning_details`. */
async function* tapReasoningDetails(
  stream: AsyncIterable<any>,
  acc: ReasoningDetailAccumulator
): AsyncGenerator<any> {
  for await (const chunk of stream) {
    const details = chunk?.choices?.[0]?.delta?.reasoning_details;
    if (Array.isArray(details)) mergeReasoningDetailDelta(acc, details);
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
    toOpenAIMessages(input, { toolImagesInUserMessage: true, nativeTurnProvider: nativeKey })
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
  const usage = await accumulateOpenAIChatStream(
    tapReasoningDetails(stream, details),
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const validated = filterValidToolCalls(event.objectDelta as ToolCalls, input.tools);
        if (validated.length > 0) {
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
  if (items !== undefined) {
    emit({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: nativeKey, payload: JSON.stringify(items) },
    });
  }
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
