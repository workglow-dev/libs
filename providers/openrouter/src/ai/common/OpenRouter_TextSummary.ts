/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  Usage,
} from "@workglow/ai";
import {
  createChatRefusalReader,
  createEstimatedOutputUsageReporter,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { getClient, getModelName } from "./OpenRouter_Client";
import type { OpenRouterModelConfig } from "./OpenRouter_ModelSchema";
import { buildOpenRouterExtras } from "./OpenRouter_RequestParams";
import { mapOpenRouterUsage } from "./OpenRouter_Usage";

/** Streaming run-fn for `["text.summary"]`. */
export const OpenRouter_TextSummary_Stream: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  OpenRouterModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(
    `Summarize the following text concisely.\n${typeof input.text === "string" ? input.text : ""}`
  );

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages: [
        { role: "system", content: "Summarize the following text concisely." },
        { role: "user", content: input.text },
      ],
      stream: true,
      ...buildOpenRouterExtras(model),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  let usage: Usage | undefined;
  const refusals = createChatRefusalReader(emit);
  for await (const chunk of stream) {
    usage = mapOpenRouterUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      provisionalUsage.onText(delta);
      emit({ type: "text-delta", port: "text", textDelta: delta });
    }
    refusals.read(chunk.choices?.[0]);
  }
  provisionalUsage.flush();
  emit({ type: "finish", data: {} as TextSummaryTaskOutput, usage });
};
