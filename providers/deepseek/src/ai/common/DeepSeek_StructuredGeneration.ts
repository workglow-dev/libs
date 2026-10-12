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
  createEstimatedOutputUsageReporter,
  jsonModeChatParts,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
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
 * Streaming run-fn for `["text.generation", "json-mode"]`. Emits
 * `object-delta` events with progressively-completed partial JSON snapshots
 * on the `object` port, ending with a `finish` event carrying the parsed
 * final object.
 *
 * DeepSeek supports only `response_format: { type: "json_object" }` — passing
 * OpenAI's `json_schema` form returns `400 This response_format type is
 * unavailable now`. {@link jsonModeChatParts} puts the schema in the prompt
 * (and includes a lowercase "json", which DeepSeek requires).
 */
export const DeepSeek_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  DeepSeekModelConfig
> = async (input, model, signal, emit, outputSchema) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const schema = input.outputSchema ?? outputSchema;
  const { prompt: userContent, responseFormat } = jsonModeChatParts(input.prompt, schema, {
    jsonSchemaSupported: false,
  });

  // DeepSeek only attaches billed usage to the final empty-choices chunk, so
  // without a provisional estimate the CLI row stays on a static "Preparing"
  // for the whole TTFB wait. Emit ↑ before the request so it appears during
  // connect; finish.usage below still carries the provider total.
  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(userContent);

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages: [{ role: "user", content: userContent }],
      response_format: responseFormat as never,
      max_tokens: resolveMaxTokens(model, input.maxTokens),
      ...reasoningParams(model),
      temperature: input.temperature,
      stream: true,
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  const json = createPartialJsonStream();
  let refusal = "";
  let finishReason: string | null | undefined;
  let usage: Usage | undefined;
  // The reasoning-exhaustion guard below only distinguishes "no content at all"
  // from "some content", so retaining one delta answers it without re-growing a
  // copy of the whole document.
  let anyContent = "";
  for await (const chunk of stream) {
    usage = mapDeepSeekUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      if (anyContent === "") anyContent = delta;
      provisionalUsage.onText(delta);
      const partial = json.push(delta);
      if (partial !== undefined) {
        emit({ type: "object-delta", port: "object", objectDelta: partial });
      }
    }
    refusal += chunk.choices?.[0]?.delta?.refusal ?? "";
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
  }
  provisionalUsage.flush();

  if (refusal) {
    emit({ type: "refusal", refusal });
  }

  assertNotTruncatedByReasoning(finishReason, anyContent, input.maxTokens);

  emit({
    type: "finish",
    data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
    usage,
  });
};
