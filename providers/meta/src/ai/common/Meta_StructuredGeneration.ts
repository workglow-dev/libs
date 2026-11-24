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
  mapOpenAIChatUsage,
} from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import {
  createMetaChatStream,
  getClient,
  getMetaReasoningEffort,
  getModelName,
  metaSamplingParams,
} from "./Meta_Client";
import type { MetaModelConfig } from "./Meta_ModelSchema";

/**
 * `json_schema` is the only `response_format` Meta documents. A schema that
 * fits the strict subset is sent strict; any other is sent with
 * `strict: false` (Meta's default) and also written into the prompt, where the
 * shared helper would fall back to `json_object`, which Meta does not list.
 */
function metaJsonModeParts(
  prompt: string,
  schema: unknown
): { prompt: string; responseFormat: Record<string, unknown> } {
  const parts = jsonModeChatParts(prompt, schema);
  if (parts.responseFormat.type === "json_schema") {
    return { prompt: parts.prompt, responseFormat: parts.responseFormat };
  }
  const loose =
    schema !== null && typeof schema === "object" ? schema : { type: "object" as const };
  return {
    prompt: parts.prompt,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "structured_output", schema: loose, strict: false },
    },
  };
}

/**
 * Streaming run-fn for `["text.generation", "json-mode"]`. Emits
 * `object-delta` events with progressively-completed partial JSON snapshots
 * on the `object` port, ending with a `finish` event carrying the parsed
 * final object.
 */
export const Meta_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  MetaModelConfig
> = async (input, model, signal, emit, outputSchema) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const schema = input.outputSchema ?? outputSchema;
  const { prompt, responseFormat } = metaJsonModeParts(input.prompt, schema);

  // Billed usage arrives, if at all, on the final chunk, so without a
  // provisional estimate the CLI row stays on a static "Preparing" for the
  // whole TTFB wait. Emit ↑ before the request so it appears during connect;
  // finish.usage below still carries the provider total.
  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(prompt);
  const reasoningEffort = getMetaReasoningEffort(model);

  const stream = await createMetaChatStream(
    client,
    {
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      response_format: responseFormat,
      ...(input.maxTokens !== undefined ? { max_completion_tokens: input.maxTokens } : {}),
      ...metaSamplingParams({ temperature: input.temperature }),
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    },
    signal
  );

  const json = createPartialJsonStream();
  let refusal = "";
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
    refusal += chunk.choices?.[0]?.delta?.refusal ?? "";
  }
  provisionalUsage.flush();

  if (refusal) {
    emit({ type: "refusal", refusal });
  }

  emit({
    type: "finish",
    data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
    usage,
  });
};
