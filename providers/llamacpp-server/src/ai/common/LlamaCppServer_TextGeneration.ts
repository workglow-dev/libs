/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  LooseChatMessage,
  OpenAICompatMessage,
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  Usage,
} from "@workglow/ai";
import { liftSystemMessages, normalizeChatMessages, toOpenAIMessages } from "@workglow/ai/worker";
import {
  createEstimatedOutputUsageReporter,
  localOnlyFetch,
  mapOpenAIChatUsage,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import {
  acquireBaseUrl,
  buildServerUrl,
  readChatCompletionDeltas,
  type ILlamaCppServerProviderOptions,
} from "./LlamaCppServer_Client";
import type { LlamaCppServerModelConfig } from "./LlamaCppServer_ModelSchema";
import { getLlamaCppServerModelName } from "./LlamaCppServer_ModelUtil";

type AcquireFn = typeof acquireBaseUrl;

interface UnifiedTextGenerationInput extends TextGenerationTaskInput {
  readonly messages?: ReadonlyArray<LooseChatMessage>;
  readonly systemPrompt?: string;
}

/**
 * Streaming run-fn factory for `["text.generation"]` (and, when the model has
 * `vision-input`, image-bearing chat content too).
 *
 * Discriminates on `Array.isArray(input.messages) && input.messages.length > 0`
 * so {@link AiChatTask} and {@link TextGenerationTask} share the same
 * registered run-fn, consistent with the project convention.
 *
 * Vision-input is folded into this run-fn rather than living separately:
 * llava-family chat is still a `/v1/chat/completions` call — only the
 * `content` shape changes. The provider's `inferCapabilities` decides
 * whether `vision-input` is declared.
 */
export function createLlamaCppServerTextGenerationStream(
  opts: ILlamaCppServerProviderOptions,
  acquire: AcquireFn = acquireBaseUrl
): AiProviderRunFn<TextGenerationTaskInput, TextGenerationTaskOutput, LlamaCppServerModelConfig> {
  return async (input, model, signal, emit) => {
    signal?.throwIfAborted?.();
    const unified = input as UnifiedTextGenerationInput;
    const hasMessages = Array.isArray(unified.messages) && unified.messages.length > 0;

    // llama-server speaks chat-completions, so history goes through the shared
    // OpenAI converter: workglow image blocks become `image_url` parts (llava),
    // and blocks the endpoint has no form for are dropped rather than sent.
    const messages = hasMessages
      ? toOpenAIMessages({
          ...liftSystemMessages(normalizeChatMessages(unified.messages!), unified.systemPrompt),
          prompt: "",
          tools: [],
        } as never).map(collapseTextOnlyContent)
      : [{ role: "user", content: input.prompt }];

    const body = JSON.stringify({
      model: getLlamaCppServerModelName(model),
      messages,
      stream: true,
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { top_p: input.topP } : {}),
      ...(input.frequencyPenalty !== undefined
        ? { frequency_penalty: input.frequencyPenalty }
        : {}),
      ...(input.presencePenalty !== undefined ? { presence_penalty: input.presencePenalty } : {}),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    });

    const { baseUrl, release } = await acquire(model, opts);
    try {
      signal?.throwIfAborted?.();
      // Chat-completions only attach billed usage to the final chunk; estimate
      // ↑ before TTFB and ↓ from content so the CLI counter moves during the call.
      const provisionalUsage = createEstimatedOutputUsageReporter(emit);
      provisionalUsage.onPrompt(promptTextFromMessages(messages));

      const response = await localOnlyFetch(
        buildServerUrl(baseUrl, "/v1/chat/completions"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal,
        },
        "LlamaCppServer"
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        throw new Error(
          `LlamaCppServer: HTTP ${response.status} from /v1/chat/completions (text-generation) — ${text}`
        );
      }
      let usage: Usage | undefined;
      for await (const delta of readChatCompletionDeltas(response, signal)) {
        if (delta.done) break;
        usage = mapOpenAIChatUsage(delta.usage) ?? usage;
        if (delta.contentDelta) {
          provisionalUsage.onText(delta.contentDelta);
          emit({ type: "text-delta", port: "text", textDelta: delta.contentDelta });
        }
      }
      provisionalUsage.flush();
      emit({ type: "finish", data: {} as TextGenerationTaskOutput, usage });
    } finally {
      await release();
    }
  };
}

/**
 * A user turn that is text alone goes out as a plain string, as it always has:
 * only a turn carrying an image needs the parts array, and a server built
 * without multimodal support is the one that may not accept one.
 */
function collapseTextOnlyContent(message: OpenAICompatMessage): OpenAICompatMessage {
  const content = message.content;
  if (!Array.isArray(content) || !content.every((part) => part.type === "text")) return message;
  return {
    ...message,
    content: content.map((part) => (typeof part.text === "string" ? part.text : "")).join(""),
  };
}

function promptTextFromMessages(messages: ReadonlyArray<{ readonly content: unknown }>): string {
  const parts: string[] = [];
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}
