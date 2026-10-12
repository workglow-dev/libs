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
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { getLogger } from "@workglow/util/worker";
import {
  annotateLastBlock,
  applyAnthropicPrefixReplay,
  wrapSystemWithCacheControl,
} from "./Anthropic_CacheCheckpoint";
import { getClient, getMaxTokens, getModelName } from "./Anthropic_Client";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import { maybeEmitAnthropicRefusal } from "./Anthropic_Refusal";
import { applyAnthropicSamplingParams } from "./Anthropic_RequestParams";
import { applyAnthropicThinkingParams } from "./Anthropic_Thinking";
import { buildAnthropicMessages } from "./Anthropic_ToolCalling";
import { createAnthropicUsageCollector } from "./Anthropic_Usage";

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
 * Streaming run-fn for the `["text.generation"]` capability. Used by both
 * {@link TextGenerationTask} (prompt-only input) and {@link AiChatTask}
 * (full conversation history). Yields `text-delta` events on the `text` port
 * and a final empty `finish` event per the streaming convention (consumer
 * accumulates).
 *
 * Discriminates on `Array.isArray(input.messages) && input.messages.length > 0`
 * to choose the chat vs. prompt path — safe because AiChatTask always provides
 * `messages` and TextGenerationTask never does.
 */
export const Anthropic_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  AnthropicModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const sessionId = sessionContext?.sessionId;
  const logger = getLogger();
  const timerLabel = `anthropic:TextGeneration:${getModelName(model)}`;
  logger.time(timerLabel, { model: getModelName(model) });
  try {
    const client = await getClient(model);
    const modelName = getModelName(model);
    const unified = input as UnifiedTextGenerationInput;
    const hasMessages = Array.isArray(unified.messages) && unified.messages.length > 0;

    const messages = hasMessages
      ? buildAnthropicMessages(
          unified.messages as Parameters<typeof buildAnthropicMessages>[0],
          unified.prompt ?? "",
          undefined
        )
      : [{ role: "user" as const, content: input.prompt }];

    const params: Record<string, unknown> = {
      model: modelName,
      messages,
      max_tokens: getMaxTokens(input, model),
    };
    applyAnthropicThinkingParams(params, model);
    applyAnthropicSamplingParams(params, input, model);

    // Emit-only run (emitCheckpoint with no parent checkpoint): this request
    // is the cache write the emitted checkpoint's first consumer reads, so it
    // needs the plain-session-style breakpoints even without a sessionId.
    const emitBoundary =
      sessionContext?.emitCheckpointId !== undefined && sessionContext?.prefix === undefined;

    if (unified.systemPrompt) {
      params.system =
        sessionId || emitBoundary
          ? wrapSystemWithCacheControl(unified.systemPrompt)
          : unified.systemPrompt;
    }

    if (sessionContext?.prefix) {
      applyAnthropicPrefixReplay(params, sessionContext);
    } else if ((sessionId !== undefined && hasMessages) || emitBoundary) {
      // Plain session: annotate the last message per turn. Emit-only run: mark
      // the emit boundary (a string prompt tail is lifted into an annotated
      // block by annotateLastBlock).
      if (messages.length > 0) {
        annotateLastBlock(messages[messages.length - 1] as { content: unknown });
      }
    }

    const stream = (client.messages.stream as (p: unknown, o: unknown) => AsyncIterable<unknown>)(
      params,
      { signal }
    );

    const usageCollector = createAnthropicUsageCollector();
    const snapshotUsage = createUsageSnapshotEmitter(emit);
    for await (const event of stream) {
      usageCollector.observe(event);
      snapshotUsage(usageCollector.result());
      const e = event as {
        type: string;
        delta?: { type?: string; text?: string };
      };
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        emit({ type: "text-delta", port: "text", textDelta: e.delta.text ?? "" });
      }
      maybeEmitAnthropicRefusal(event, emit);
    }
    emit({
      type: "finish",
      data: {} as TextGenerationTaskOutput,
      usage: usageCollector.result(),
    });
  } finally {
    logger.timeEnd(timerLabel, { model: getModelName(model) });
  }
};
