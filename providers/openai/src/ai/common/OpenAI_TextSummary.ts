/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextSummaryTaskInput, TextSummaryTaskOutput } from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  createEstimatedOutputUsageReporter,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import { finalizeResponsesRequest, getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";
import { createResponsesEventStream } from "./OpenAI_ResponsesCall";

/**
 * Streaming run-fn for `["text.summary"]`. Emits `text-delta` events on
 * the `text` port and a final empty `finish` event.
 */
export const OpenAI_TextSummary_Stream: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);

  const params: Record<string, unknown> = {
    model: getModelName(model),
    instructions: "Summarize the following text concisely.",
    input: input.text,
  };
  finalizeResponsesRequest(model, params);

  const promptText = promptTextForResponsesUsageEstimate(params);
  createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

  const stream = await createResponsesEventStream(client, params, model, signal);

  const usage = await accumulateOpenAIResponsesStream(stream as AsyncIterable<unknown>, emit, {
    promptText,
  });
  emit({ type: "finish", data: {} as TextSummaryTaskOutput, usage });
};
