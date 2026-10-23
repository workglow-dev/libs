/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextRewriterTaskInput, TextRewriterTaskOutput } from "@workglow/ai";
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { getClient, getMaxTokens, getModelName } from "./Anthropic_Client";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import { maybeEmitAnthropicRefusal } from "./Anthropic_Refusal";
import { applyAnthropicThinkingParams } from "./Anthropic_Thinking";
import { createAnthropicUsageCollector } from "./Anthropic_Usage";

export const Anthropic_TextRewriter_Stream: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  AnthropicModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const params: Record<string, unknown> = {
    model: modelName,
    system: input.prompt,
    messages: [{ role: "user", content: input.text }],
    max_tokens: getMaxTokens(input, model),
  };
  // This task takes no sampling parameters, so thinking needs no temperature
  // guard here. Only `text_delta` reaches the output below, so the thinking
  // stays out of the text.
  applyAnthropicThinkingParams(params, model);

  const stream = (client.messages.stream as (p: unknown, o: unknown) => AsyncIterable<unknown>)(
    params,
    { signal }
  );

  const usageCollector = createAnthropicUsageCollector();
  const snapshotUsage = createUsageSnapshotEmitter(emit);
  for await (const event of stream) {
    usageCollector.observe(event);
    snapshotUsage(usageCollector.result());
    maybeEmitAnthropicRefusal(event, emit);
    const e = event as { type: string; delta?: { type?: string; text?: string } };
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      emit({ type: "text-delta", port: "text", textDelta: e.delta.text ?? "" });
    }
  }
  emit({ type: "finish", data: {} as TextRewriterTaskOutput, usage: usageCollector.result() });
};
