/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
} from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  buildResponsesInput,
  buildResponsesTools,
  createEstimatedOutputUsageReporter,
  mapResponsesToolChoice,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import { mergeOpenAICheckpointPrefix, openAIConversationOptions } from "./OpenAI_CacheCheckpoint";
import {
  finalizeResponsesRequest,
  getClient,
  getModelName,
  requestReasoningSummary,
} from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Calls the OpenAI
 * Responses endpoint with `stream: true` and forwards delta events via
 * {@link accumulateOpenAIResponsesStream}, which emits `text-delta` and tool-call
 * `object-delta` events plus a final empty `finish`. A reasoning summary, asked
 * for only through `provider_config.reasoning.summary`, streams on `reasoning`. The turn's own output
 * items go back on the `nativeTurn` port only when the request asked for
 * encrypted reasoning, since a replayed reasoning item without it is looked up
 * by id and fails where the response is not stored.
 *
 * Defence-in-depth: each tool-call `object-delta` is filtered against the
 * effective tool declarations (the caller's tools, or the checkpoint prefix's
 * on fallback) so a hallucinated function name never reaches the consumer.
 */
export const OpenAI_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  // Checkpoint consumption: replay the prefix content ahead of the tail so the
  // request's literal prefix matches the warm-up and hits the automatic
  // server-side prompt cache. The effective tool declarations come from the
  // merge too — the caller's tools win, and an empty list falls back to the
  // prefix's so the warmed tool segment (and its prompt_cache_key) is shared.
  const merged = mergeOpenAICheckpointPrefix(sessionContext, input);
  const toolDefinitions = merged?.tools ?? input.tools;
  const tools = buildResponsesTools(toolDefinitions);
  const conversation = merged
    ? ({
        ...input,
        messages: merged.messages,
        systemPrompt: merged.systemPrompt,
        prompt: "",
      } as ToolCallingTaskInput)
    : input;
  const { input: responsesInput, instructions } = buildResponsesInput({
    messages: toOpenAIMessages(conversation, { toolImagesInUserMessage: true }),
  });
  const toolChoice = mapResponsesToolChoice(input.toolChoice);

  const params: Record<string, unknown> = {
    model: modelName,
    input: responsesInput,
    tools,
    tool_choice: toolChoice,
  };
  if (instructions !== undefined) params.instructions = instructions;
  if (input.maxTokens !== undefined) params.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined) params.temperature = input.temperature;
  finalizeResponsesRequest(model, params);
  // A summary of the round's reasoning, when the model record opted into one,
  // streams on the `reasoning` port.
  requestReasoningSummary(model, params);
  // A reasoning model starts its thinking over every round unless it is handed
  // its encrypted reasoning back; the items come back on `nativeTurn`. The
  // input is written the way the checkpoint warm-up writes it, so a prefix
  // still matches.
  const conversationOptions = openAIConversationOptions(model, params);
  const nativeKey = conversationOptions.nativeTurnProvider;
  if (nativeKey !== undefined) {
    params.include = ["reasoning.encrypted_content"];
    params.input = buildResponsesInput({
      messages: toOpenAIMessages(conversation, conversationOptions),
    }).input;
  }

  const promptText = promptTextForResponsesUsageEstimate(params);
  createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

  const stream = await client.responses.create(
    { ...params, stream: true } as Parameters<typeof client.responses.create>[0],
    { signal }
  );

  const usage = await accumulateOpenAIResponsesStream<ToolCallingTaskOutput>(
    stream as AsyncIterable<unknown>,
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const validated = filterValidToolCalls(event.objectDelta as ToolCalls, toolDefinitions);
        if (validated.length > 0) {
          emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
        }
        return;
      }
      emit(event);
    },
    { promptText, nativeTurnProvider: nativeKey, forwardReasoning: true }
  );
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
