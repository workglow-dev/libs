/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  Usage,
} from "@workglow/ai";
import {
  createChatRefusalReader,
  createEstimatedOutputUsageReporter,
  jsonModeChatParts,
  mapOpenAIChatUsage,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import { getClient, getModelName, getXaiReasoningEffort } from "./Xai_Client";
import type { XaiModelConfig } from "./Xai_ModelSchema";

/**
 * Streaming run-fn for `["text.generation", "json-mode"]`. Emits
 * `object-delta` events with progressively-completed partial JSON snapshots
 * on the `object` port, ending with a `finish` event carrying the parsed
 * final object.
 */
export const Xai_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  XaiModelConfig
> = async (input, model, signal, emit, outputSchema) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const schema = input.outputSchema ?? outputSchema;
  const { prompt, responseFormat } = jsonModeChatParts(input.prompt, schema);

  // xAI only attaches billed usage to the final empty-choices chunk, so without
  // a provisional estimate the CLI row stays on a static "Preparing" for the
  // whole TTFB wait. Emit ↑ before the request so it appears during connect;
  // finish.usage below still carries the provider total.
  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(prompt);
  const reasoningEffort = getXaiReasoningEffort(model);

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      response_format: responseFormat as never,
      max_completion_tokens: input.maxTokens,
      temperature: input.temperature,
      stream: true,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  const json = createPartialJsonStream();
  const refusals = createChatRefusalReader(emit);
  let usage: Usage | undefined;
  for await (const chunk of stream) {
    usage = mapOpenAIChatUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      provisionalUsage.onText(delta);
      const partial = json.push(delta);
      if (partial !== undefined) {
        emit({ type: "object-delta", port: "object", objectDelta: partial });
      }
    }
    refusals.read(chunk.choices?.[0]);
  }
  provisionalUsage.flush();

  emit({
    type: "finish",
    data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
    usage,
  });
};
