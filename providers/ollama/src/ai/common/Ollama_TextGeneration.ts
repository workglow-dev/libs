/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  LooseChatMessage,
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  Usage,
} from "@workglow/ai";
import { liftSystemMessages, normalizeChatMessages, toTextFlatMessages } from "@workglow/ai/worker";
import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";
import { getOllamaModelName } from "./Ollama_ModelUtil";
import { mapOllamaUsage } from "./Ollama_Usage";

type GetClient = (model: OllamaModelConfig | undefined) => Promise<any>;

interface UnifiedTextGenerationInput extends TextGenerationTaskInput {
  readonly messages?: ReadonlyArray<LooseChatMessage>;
  readonly systemPrompt?: string;
}

interface OllamaChatMessage {
  readonly role: string;
  readonly content: string;
  /** Base64 image data, which Ollama takes beside the text rather than inside it. */
  readonly images?: readonly string[];
}

/**
 * Chat history in Ollama's shape: `content` is a string, and a user turn's
 * images ride in its own `images` field. The text comes from the shared
 * flattener, which keeps every user turn (so the Nth user turn there is the Nth
 * here) and drops the blocks Ollama has no form for.
 */
export function toOllamaChatMessages(
  messages: ReadonlyArray<LooseChatMessage>,
  systemPrompt: string | undefined
): OllamaChatMessage[] {
  const lifted = liftSystemMessages(normalizeChatMessages(messages), systemPrompt);
  const history = lifted.messages;
  const userImages = history
    .filter((message) => message.role === "user")
    .map((message) =>
      message.content.flatMap((block) => (block.type === "image" ? [block.data] : []))
    );
  let userIndex = 0;
  return toTextFlatMessages({
    messages: history,
    systemPrompt: lifted.systemPrompt,
    prompt: "",
    tools: [],
  } as never).map((message) => {
    if (message.role !== "user") return message;
    const images = userImages[userIndex++] ?? [];
    return images.length > 0 ? { ...message, images } : message;
  });
}

/**
 * Streaming run-fn factory for the `["text.generation"]` capability. Returns
 * an async generator that yields `text-delta` events and a final empty
 * `finish` event (consumer accumulates).
 *
 * Discriminates on `Array.isArray(input.messages) && input.messages.length > 0`
 * so {@link AiChatTask} (chat path) and {@link TextGenerationTask}
 * (prompt-only path) share the same registered run-fn.
 */
export function createOllamaTextGenerationStream(
  getClient: GetClient
): AiProviderRunFn<TextGenerationTaskInput, TextGenerationTaskOutput, OllamaModelConfig> {
  return async (input, model, signal, emit) => {
    signal?.throwIfAborted?.();
    const client = await getClient(model);
    const modelName = getOllamaModelName(model);
    const unified = input as UnifiedTextGenerationInput;
    const hasMessages = Array.isArray(unified.messages) && unified.messages.length > 0;

    const messages: OllamaChatMessage[] = hasMessages
      ? toOllamaChatMessages(unified.messages!, unified.systemPrompt)
      : [{ role: "user", content: input.prompt }];

    // Ollama only reports counts on the terminal `done: true` chunk; estimate ↑
    // before the request and ↓ from deltas so the CLI counter moves during the call.
    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(
      messages
        .map((m) => m.content)
        .filter(Boolean)
        .join("\n")
    );

    const stream = await client.chat({
      model: modelName,
      messages,
      options: {
        temperature: input.temperature,
        top_p: input.topP,
        num_predict: input.maxTokens,
        frequency_penalty: input.frequencyPenalty,
        presence_penalty: input.presencePenalty,
      },
      stream: true,
    });

    const onAbort = (): void => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) stream.abort();
      signal?.throwIfAborted?.();
      let usage: Usage | undefined;
      for await (const chunk of stream) {
        usage = mapOllamaUsage(chunk) ?? usage;
        const delta = chunk.message.content;
        if (delta) {
          provisionalUsage.onText(delta);
          emit({ type: "text-delta", port: "text", textDelta: delta });
        }
      }
      provisionalUsage.flush();
      emit({ type: "finish", data: {} as TextGenerationTaskOutput, usage });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
