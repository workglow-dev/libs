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
  createEstimatedOutputUsageReporter,
  mapOpenAIChatUsage,
} from "@workglow/ai/provider-utils";
import { toOpenAIMessages } from "@workglow/ai/worker";
import { getLogger } from "@workglow/util/worker";
import {
  createMetaChatStream,
  getClient,
  getMetaReasoningEffort,
  getModelName,
  metaSamplingParams,
} from "./Meta_Client";
import type { MetaModelConfig } from "./Meta_ModelSchema";

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
}

/**
 * Build the chat-completion request parameters from the unified input shape —
 * preferring a populated `messages` array (AiChatTask) and falling back to
 * wrapping `prompt` as a single user message (TextGenerationTask).
 */
function buildChatParams(
  input: UnifiedTextGenerationInput,
  model: MetaModelConfig | undefined
): Record<string, unknown> {
  const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
  const messages = hasMessages
    ? toOpenAIMessages({
        messages: input.messages,
        systemPrompt: input.systemPrompt,
        prompt: "",
        tools: [],
      } as never)
    : [{ role: "user" as const, content: input.prompt }];

  const params: Record<string, unknown> = {
    model: getModelName(model),
    messages,
  };
  if (input.maxTokens !== undefined) params.max_completion_tokens = input.maxTokens;
  // Meta refuses `frequency_penalty` / `presence_penalty`, so a caller's
  // penalties are dropped rather than failing the request.
  Object.assign(
    params,
    metaSamplingParams({
      temperature: input.temperature,
      topP: (input as { topP?: number }).topP,
    })
  );
  const reasoningEffort = getMetaReasoningEffort(model);
  if (reasoningEffort !== undefined) params.reasoning_effort = reasoningEffort;
  return params;
}

/**
 * Streaming run-fn for the `["text.generation"]` capability. Used by both
 * {@link TextGenerationTask} (prompt-only input) and {@link AiChatTask}
 * (full conversation history). Emits `text-delta` events on the `text` port
 * and a final empty `finish` event per the streaming convention (consumer
 * accumulates).
 */
export const Meta_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  MetaModelConfig
> = async (input, model, signal, emit) => {
  const logger = getLogger();
  const timerLabel = `meta:TextGeneration:${getModelName(model)}`;
  logger.time(timerLabel, { model: getModelName(model) });
  try {
    const client = await getClient(model);
    const params = buildChatParams(input as UnifiedTextGenerationInput, model);

    // Billed usage arrives, if at all, on the final chunk; estimate ↑ from the
    // request (before TTFB) and ↓ from streamed text so the CLI counter moves
    // during the call. finish.usage still carries billed totals.
    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(promptTextForUsageEstimate(params.messages));

    const stream = await createMetaChatStream(client, params, signal);

    let usage: Usage | undefined;
    for await (const chunk of stream as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string | null; refusal?: string | null } }>;
      usage?: unknown;
    }>) {
      // The usage-bearing chunk arrives last with an empty `choices` array; the
      // delta reads below already tolerate that, so nothing else needs guarding.
      usage = mapOpenAIChatUsage(chunk.usage) ?? usage;
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        provisionalUsage.onText(delta);
        emit({ type: "text-delta", port: "text", textDelta: delta });
      }
      const refusalDelta = chunk.choices?.[0]?.delta?.refusal ?? "";
      if (refusalDelta) {
        emit({ type: "refusal", refusal: refusalDelta });
      }
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
