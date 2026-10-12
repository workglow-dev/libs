/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
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
import { getClient, getModelName, getProvider } from "./HFI_Client";
import { hfiReasoningParams } from "./HFI_EffortPolicy";
import type { HfInferenceModelConfig } from "./HFI_ModelSchema";

/**
 * `TextGenerationTask` and `AiChatTask` share `requires: ["text.generation"]`,
 * so the dispatcher routes both here. AiChatTask supplies a populated
 * `messages` array; TextGenerationTask supplies only a `prompt` string.
 */
interface UnifiedTextGenerationInput extends TextGenerationTaskInput {
  readonly messages?: readonly unknown[];
  readonly systemPrompt?: string;
}

export const HFI_TextGeneration_Stream: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  HfInferenceModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);
  const provider = getProvider(model);

  // Prefer a populated chat history (AiChatTask); fall back to wrapping
  // `prompt` as a single user turn (TextGenerationTask). Without this, chat
  // history routed to HFI was silently dropped.
  const unified = input as UnifiedTextGenerationInput;
  const hasMessages = Array.isArray(unified.messages) && unified.messages.length > 0;
  // HF's chat endpoint is OpenAI-compatible at runtime, but the SDK types a
  // content part's `type` as a narrow enum, so the OpenAI-shaped messages need
  // a cast to the client's expected parameter type. Null content (e.g. an
  // assistant tool-call turn) is coerced to an empty string.
  const messages = (hasMessages
    ? toOpenAIMessages({
        messages: unified.messages,
        systemPrompt: unified.systemPrompt,
        prompt: "",
        tools: [],
      } as never).map((m) => ({ ...m, content: m.content ?? "" }))
    : [{ role: "user", content: input.prompt }]) as unknown as Parameters<
    typeof client.chatCompletionStream
  >[0]["messages"];

  // HF Inference rarely reports mid-stream usage; estimate ↑ before the request
  // and ↓ from deltas so the CLI counter still moves during the call.
  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(
    messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean)
      .join("\n")
  );

  const stream = client.chatCompletionStream(
    {
      model: modelName,
      messages,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      top_p: input.topP,
      frequency_penalty: input.frequencyPenalty,
      provider,
      ...hfiReasoningParams(model),
    },
    { signal }
  );

  // The usage-bearing chunk arrives last with an empty `choices` array, so it
  // is read before the delta guard below rather than inside it. Whether it
  // arrives at all is up to the third-party provider the request is routed to;
  // when it does not, `usage` stays undefined and the estimate above remains
  // the only feedback.
  let usage: Usage | undefined;
  for await (const chunk of stream) {
    usage = mapOpenAIChatUsage((chunk as { usage?: unknown }).usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      provisionalUsage.onText(delta);
      emit({ type: "text-delta", port: "text", textDelta: delta });
    }
  }
  provisionalUsage.flush();
  emit({ type: "finish", data: {} as TextGenerationTaskOutput, usage });
};
