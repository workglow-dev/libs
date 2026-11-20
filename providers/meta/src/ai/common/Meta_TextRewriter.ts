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
  mapOpenAIChatUsage,
} from "@workglow/ai/provider-utils";
import {
  createMetaChatStream,
  getClient,
  getMetaReasoningEffort,
  getModelName,
} from "./Meta_Client";
import type { MetaModelConfig } from "./Meta_ModelSchema";

/**
 * Streaming run-fn for `["text.rewriter"]`. Emits `text-delta` events on the
 * `text` port and a final empty `finish` event.
 */
export const Meta_TextRewriter_Stream: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  MetaModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(
    `${typeof input.prompt === "string" ? input.prompt : ""}\n${typeof input.text === "string" ? input.text : ""}`
  );

  const reasoningEffort = getMetaReasoningEffort(model);

  const stream = await createMetaChatStream(
    client,
    {
      model: modelName,
      messages: [
        { role: "system", content: input.prompt },
        { role: "user", content: input.text },
      ],
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    },
    signal
  );

  let usage: Usage | undefined;
  for await (const chunk of stream) {
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
  emit({ type: "finish", data: {} as TextRewriterTaskOutput, usage });
};
