/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  Usage,
} from "@workglow/ai";
import {
  createChatRefusalReader,
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

export function createLlamaCppServerTextRewriterStream(
  opts: ILlamaCppServerProviderOptions,
  acquire: AcquireFn = acquireBaseUrl
): AiProviderRunFn<TextRewriterTaskInput, TextRewriterTaskOutput, LlamaCppServerModelConfig> {
  return async (input, model, signal, emit) => {
    signal?.throwIfAborted?.();
    const body = JSON.stringify({
      model: getLlamaCppServerModelName(model),
      messages: [
        { role: "system", content: input.prompt },
        { role: "user", content: input.text },
      ],
      stream: true,
      ...OPENAI_STREAM_USAGE_OPTIONS,
    });
    const { baseUrl, release } = await acquire(model, opts);
    try {
      const provisionalUsage = createEstimatedOutputUsageReporter(emit);
      provisionalUsage.onPrompt(
        `${typeof input.prompt === "string" ? input.prompt : ""}\n${typeof input.text === "string" ? input.text : ""}`
      );

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
          `LlamaCppServer: HTTP ${response.status} from /v1/chat/completions (rewriter) — ${text}`
        );
      }
      let usage: Usage | undefined;
      const refusals = createChatRefusalReader(emit);
      for await (const delta of readChatCompletionDeltas(response, signal)) {
        if (delta.done) break;
        usage = mapOpenAIChatUsage(delta.usage) ?? usage;
        refusals.read({
          delta: { refusal: delta.refusalDelta },
          finish_reason: delta.finishReason,
        });
        if (delta.contentDelta) {
          provisionalUsage.onText(delta.contentDelta);
          emit({ type: "text-delta", port: "text", textDelta: delta.contentDelta });
        }
      }
      provisionalUsage.flush();
      emit({ type: "finish", data: {} as TextRewriterTaskOutput, usage });
    } finally {
      await release();
    }
  };
}
