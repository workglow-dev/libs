/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextRewriterTaskInput, TextRewriterTaskOutput } from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  createEstimatedOutputUsageReporter,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import { finalizeResponsesRequest, getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";
import { createResponsesEventStream } from "./OpenAI_ResponsesCall";

/**
 * Streaming run-fn for `["text.rewriter"]`. Emits `text-delta` events on
 * the `text` port and a final empty `finish` event. The rewrite instruction
 * is sent as the Responses `instructions` (system) channel.
 */
export const OpenAI_TextRewriter_Stream: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);

  const params: Record<string, unknown> = {
    model: getModelName(model),
    instructions: input.prompt,
    input: input.text,
  };
  finalizeResponsesRequest(model, params);

  const promptText = promptTextForResponsesUsageEstimate(params);
  createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

  const stream = await createResponsesEventStream(client, params, model, signal);

  const usage = await accumulateOpenAIResponsesStream(stream as AsyncIterable<unknown>, emit, {
    promptText,
  });
  emit({ type: "finish", data: {} as TextRewriterTaskOutput, usage });
};
