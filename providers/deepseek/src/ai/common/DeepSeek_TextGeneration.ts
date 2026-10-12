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
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { toOpenAIMessages } from "@workglow/ai/worker";
import { getLogger } from "@workglow/util/worker";
import {
  assertNotTruncatedByReasoning,
  getClient,
  getModelName,
  resolveMaxTokens,
  reasoningParams,
} from "./DeepSeek_Client";
import type { DeepSeekModelConfig } from "./DeepSeek_ModelSchema";
import { mapDeepSeekUsage } from "./DeepSeek_Usage";

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
  model: DeepSeekModelConfig | undefined
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
  const resolvedMaxTokens = resolveMaxTokens(model, input.maxTokens);
  if (resolvedMaxTokens !== undefined) params.max_tokens = resolvedMaxTokens;
  Object.assign(params, reasoningParams(model));
  if (input.temperature !== undefined) params.temperature = input.temperature;
  if ((input as { topP?: number }).topP !== undefined)
    params.top_p = (input as { topP?: number }).topP;
  if ((input as { frequencyPenalty?: number }).frequencyPenalty !== undefined)
    params.frequency_penalty = (input as { frequencyPenalty?: number }).frequencyPenalty;
  if ((input as { presencePenalty?: number }).presencePenalty !== undefined)
    params.presence_penalty = (input as { presencePenalty?: number }).presencePenalty;
  return params;
}

/**
 * Streaming run-fn for the `["text.generation"]` capability. Used by both
 * {@link TextGenerationTask} (prompt-only input) and {@link AiChatTask}
 * (full conversation history). Emits `text-delta` events on the `text` port
 * and a final empty `finish` event per the streaming convention (consumer
 * accumulates).
 */
export const DeepSeek_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  DeepSeekModelConfig
> = async (input, model, signal, emit) => {
  const logger = getLogger();
  const timerLabel = `deepseek:TextGeneration:${getModelName(model)}`;
  logger.time(timerLabel, { model: getModelName(model) });
  try {
    const client = await getClient(model);
    const params = buildChatParams(input as UnifiedTextGenerationInput, model);

    // DeepSeek only attaches billed usage to the final empty-choices chunk;
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

    let emittedText = "";
    let finishReason: string | null | undefined;
    let usage: Usage | undefined;
    for await (const chunk of stream as AsyncIterable<{
      choices?: Array<{
        delta?: { content?: string | null; refusal?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: unknown;
    }>) {
      // The usage-bearing chunk arrives last with an empty `choices` array; the
      // delta reads below already tolerate that, so nothing else needs guarding.
      usage = mapDeepSeekUsage(chunk.usage) ?? usage;
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        emittedText += delta;
        provisionalUsage.onText(delta);
        emit({ type: "text-delta", port: "text", textDelta: delta });
      }
      const refusalDelta = chunk.choices?.[0]?.delta?.refusal ?? "";
      if (refusalDelta) {
        emit({ type: "refusal", refusal: refusalDelta });
      }
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    }
    provisionalUsage.flush();
    assertNotTruncatedByReasoning(finishReason, emittedText, input.maxTokens);
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
