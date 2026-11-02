/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  Usage,
} from "@workglow/ai";
import {
  createChatRefusalReader,
  createEstimatedOutputUsageReporter,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { getLogger } from "@workglow/util/worker";
import { getClient, getModelName } from "./OpenRouter_Client";
import type { OpenRouterModelConfig } from "./OpenRouter_ModelSchema";
import { buildChatParams, buildOpenRouterExtras } from "./OpenRouter_RequestParams";
import { mapOpenRouterUsage } from "./OpenRouter_Usage";

/**
 * Streaming run-fn for `["text.generation"]`. Serves both TextGenerationTask
 * (prompt) and AiChatTask (messages). Emits `text-delta` events and a final
 * empty `finish` per the streaming convention.
 */
export const OpenRouter_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  OpenRouterModelConfig
> = async (input, model, signal, emit) => {
  const logger = getLogger();
  const timerLabel = `openrouter:TextGeneration:${getModelName(model)}`;
  logger.time(timerLabel, { model: getModelName(model) });
  try {
    const client = await getClient(model);
    const params = { ...buildChatParams(input, model), ...buildOpenRouterExtras(model) };

    // OpenRouter only attaches billed usage to the final empty-choices chunk;
    // estimate ↑ from the request (before TTFB) and ↓ from streamed text so
    // the CLI counter moves during the call. finish.usage still carries billed totals.
    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(promptTextForUsageEstimate(params.messages));

    const stream = await client.chat.completions.create(
      { ...params, stream: true, ...OPENAI_STREAM_USAGE_OPTIONS } as Parameters<
        typeof client.chat.completions.create
      >[0],
      { signal }
    );

    let usage: Usage | undefined;
    const refusals = createChatRefusalReader(emit);
    for await (const chunk of stream as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string | null; refusal?: string | null } }>;
      usage?: unknown;
    }>) {
      // The usage-bearing chunk arrives last with an empty `choices` array; the
      // delta reads below already tolerate that, so nothing else needs guarding.
      usage = mapOpenRouterUsage(chunk.usage) ?? usage;
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        provisionalUsage.onText(delta);
        emit({ type: "text-delta", port: "text", textDelta: delta });
      }
      refusals.read(chunk.choices?.[0]);
    }
    provisionalUsage.flush();
    emit({ type: "finish", data: {} as TextGenerationTaskOutput, usage });
  } finally {
    logger.timeEnd(timerLabel, { model: getModelName(model) });
  }
};

/** Flatten chat-message contents into one string for the provisional ↑ estimate. */
function promptTextForUsageEstimate(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
  }
  return parts.join("\n");
}
