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
  mapOpenAIChatUsage,
  mapOpenAIToolChoice,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import { getClient, getModelName, getXaiReasoningEffort } from "./Xai_Client";
import type { XaiModelConfig } from "./Xai_ModelSchema";

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Calls the xAI
 * chat-completions endpoint (OpenAI-compatible) with `stream: true` and
 * forwards delta events via {@link accumulateOpenAIChatStream}, which emits
 * `text-delta` and tool-call `object-delta` events plus a final empty
 * `finish`.
 *
 * Defence-in-depth: each tool-call `object-delta` is filtered against
 * `input.tools` so a hallucinated function name never reaches the consumer.
 */
export const Xai_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  XaiModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const tools = buildOpenAITools(input.tools);
  const messages = toOpenAIMessages(input, { toolImagesInUserMessage: true });
  const toolChoice = mapOpenAIToolChoice(input.toolChoice, true);
  const reasoningEffort = getXaiReasoningEffort(model);

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages,
      max_completion_tokens: input.maxTokens,
      temperature: input.temperature,
      stream: true,
      tools,
      tool_choice: toolChoice,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  const usage = await accumulateOpenAIChatStream(
    stream,
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
    mapOpenAIChatUsage,
    {
      promptText: messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n"),
    }
  );
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
