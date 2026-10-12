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
  createEstimatedOutputUsageReporter,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { getClient, getModelName, reasoningParams } from "./DeepSeek_Client";
import type { DeepSeekModelConfig } from "./DeepSeek_ModelSchema";
import { mapDeepSeekUsage } from "./DeepSeek_Usage";

/**
 * Streaming run-fn for `["text.rewriter"]`. Emits `text-delta` events on the
 * `text` port and a final empty `finish` event.
 */
export const DeepSeek_TextRewriter_Stream: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  DeepSeekModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(
    `${typeof input.prompt === "string" ? input.prompt : ""}\n${typeof input.text === "string" ? input.text : ""}`
  );

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages: [
        { role: "system", content: input.prompt },
        { role: "user", content: input.text },
      ],
      ...reasoningParams(model),
      stream: true,
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  let usage: Usage | undefined;
  for await (const chunk of stream) {
    usage = mapDeepSeekUsage(chunk.usage) ?? usage;
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
  emit({ type: "finish", data: {} as TextRewriterTaskOutput, usage });
};
