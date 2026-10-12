/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
} from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  buildResponsesInput,
  buildResponsesTools,
  createEstimatedOutputUsageReporter,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import { toOpenAIMessages } from "@workglow/ai/worker";
import { getLogger } from "@workglow/util/worker";
import { mergeOpenAICheckpointPrefix } from "./OpenAI_CacheCheckpoint";
import { finalizeResponsesRequest, getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";
import { warnPenaltyDroppedOnce } from "./OpenAI_ResponsesWarnings";

/**
 * Inputs that the unified `["text.generation"]` runFn handles. Both
 * {@link TextGenerationTask} and {@link AiChatTask} declare
 * `requires: ["text.generation"]`, so the capability dispatcher routes both
 * here. AiChatTask supplies a populated `messages` array; TextGenerationTask
 * (and other simple prompt callers) supply a `prompt` string only.
 */
interface UnifiedTextGenerationInput extends TextGenerationTaskInput {
  readonly messages?: readonly unknown[];
  readonly systemPrompt?: string;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
}

/**
 * Build the OpenAI Responses request parameters from the unified input shape —
 * preferring a populated `messages` array (AiChatTask) and falling back to the
 * `prompt` string (TextGenerationTask). Note: the Responses API does not accept
 * `frequency_penalty` / `presence_penalty`, so those are not forwarded.
 */
function buildResponsesParams(
  input: UnifiedTextGenerationInput,
  model: OpenAiModelConfig | undefined
): Record<string, unknown> {
  const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
  const messages = hasMessages
    ? toOpenAIMessages(
        {
          messages: input.messages,
          systemPrompt: input.systemPrompt,
          prompt: "",
          tools: [],
        } as never,
        // A function_call_output carries text only: images a tool returned go on a
        // user turn after the results, as the checkpoint warm-up writes them.
        { toolImagesInUserMessage: true }
      )
    : undefined;

  const { input: responsesInput, instructions } = buildResponsesInput({
    messages,
    prompt: hasMessages ? undefined : input.prompt,
    systemPrompt: hasMessages ? undefined : input.systemPrompt,
  });

  const params: Record<string, unknown> = {
    model: getModelName(model),
    input: responsesInput,
  };
  if (instructions !== undefined) params.instructions = instructions;
  if (input.maxTokens !== undefined) params.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined) params.temperature = input.temperature;
  if ((input as { topP?: number }).topP !== undefined)
    params.top_p = (input as { topP?: number }).topP;

  // frequency_penalty / presence_penalty are silently dropped by the Responses
  // API. Warn once per (model, param) so callers who set them notice.
  const modelName = getModelName(model);
  if (input.frequencyPenalty !== undefined) {
    warnPenaltyDroppedOnce(modelName, "frequencyPenalty");
  }
  if (input.presencePenalty !== undefined) {
    warnPenaltyDroppedOnce(modelName, "presencePenalty");
  }

  return params;
}

/**
 * Streaming run-fn for the `["text.generation"]` capability. Used by both
 * {@link TextGenerationTask} (prompt-only input) and {@link AiChatTask}
 * (full conversation history). Emits `text-delta` events on the `text` port
 * and a final empty `finish` event per the streaming convention (consumer
 * accumulates).
 */
export const OpenAI_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const logger = getLogger();
  const timerLabel = `openai:TextGeneration:${getModelName(model)}`;
  logger.time(timerLabel, { model: getModelName(model) });
  try {
    const client = await getClient(model);
    // Checkpoint consumption: replay the prefix content ahead of the tail so
    // the request's literal prefix matches the warm-up and hits the automatic
    // server-side prompt cache.
    const unified = input as UnifiedTextGenerationInput;
    const merged = mergeOpenAICheckpointPrefix(sessionContext, unified);
    const effective: UnifiedTextGenerationInput = merged
      ? { ...unified, messages: merged.messages, systemPrompt: merged.systemPrompt, prompt: "" }
      : unified;
    const params = buildResponsesParams(effective, model);
    // A tools-warmed prefix replays its tool declarations too: tools precede
    // the conversation in the serialized request, so omitting them would both
    // miss the warm-up's cached prefix (and diverge the prompt_cache_key) and
    // orphan replayed function_call items. tool_choice stays unset (API
    // default), matching the warm-up request.
    if (merged?.tools && merged.tools.length > 0) {
      params.tools = buildResponsesTools(merged.tools);
    }
    finalizeResponsesRequest(model, params);

    // Responses only attaches billed usage to the terminal lifecycle event;
    // estimate ↑ before the request so the CLI counter moves during TTFB.
    const promptText = promptTextForResponsesUsageEstimate(params);
    createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

    const stream = await client.responses.create(
      { ...params, stream: true } as Parameters<typeof client.responses.create>[0],
      { signal }
    );

    const usage = await accumulateOpenAIResponsesStream(stream as AsyncIterable<unknown>, emit, {
      promptText,
    });
    emit({ type: "finish", data: {} as TextGenerationTaskOutput, usage });
  } finally {
    logger.timeEnd(timerLabel, { model: getModelName(model) });
  }
};
