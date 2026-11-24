/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
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
  firstNonStrictReason,
  isStrictCompatibleSchema,
  mapOpenAIResponsesUsage,
  promptWithJsonSchema,
  rewriteNullableUnionsForStrict,
} from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import { finalizeResponsesRequest, getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";
import { warnStrictDowngradedOnce } from "./OpenAI_ResponsesWarnings";
import { createResponsesEventStream } from "./OpenAI_ResponsesCall";

export { isStrictCompatibleSchema };

/**
 * Streaming run-fn for `["text.generation", "json-mode"]`. Emits
 * `object-delta` events with progressively-completed partial JSON snapshots
 * on the `object` port, ending with a `finish` event carrying the parsed
 * final object.
 */
export const OpenAI_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit, outputSchema) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const schema = input.outputSchema ?? outputSchema;
  const rewritten = rewriteNullableUnionsForStrict(schema);
  const strict = isStrictCompatibleSchema(rewritten);
  const prompt = strict ? input.prompt : promptWithJsonSchema(input.prompt, schema);
  if (!strict) {
    // Responses still wants json_schema; without strict the model is free to
    // ignore the shape, so the schema also travels in the prompt.
    const reason = firstNonStrictReason(rewritten) ?? "unknown reason";
    warnStrictDowngradedOnce(modelName, reason);
  }

  const params: Record<string, unknown> = {
    model: modelName,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "structured_output",
        // The nullable-union rewrite is a strict-mode accommodation; a
        // downshifted request sends the schema as the caller wrote it.
        schema: strict ? rewritten : schema,
        strict,
      },
    },
  };
  if (input.maxTokens !== undefined) params.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined) params.temperature = input.temperature;
  finalizeResponsesRequest(model, params);

  // Responses only attaches billed usage to the terminal lifecycle event, so
  // without a provisional estimate the CLI row stays on a static "Preparing"
  // for the whole TTFB wait. Emit ↑ before the request so it appears during
  // connect; finish.usage below still carries the provider total.
  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(typeof prompt === "string" ? prompt : "");

  const stream = await createResponsesEventStream(client, params, model, signal);

  const json = createPartialJsonStream();
  let refusal = "";
  let usage: Usage | undefined;
  for await (const event of stream as AsyncIterable<{
    type?: string;
    delta?: string;
    response?: { usage?: unknown };
  }>) {
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      usage = mapOpenAIResponsesUsage(event.response?.usage) ?? usage;
    } else if (event.type === "response.output_text.delta") {
      const delta = event.delta ?? "";
      if (delta) {
        provisionalUsage.onText(delta);
        const partial = json.push(delta);
        if (partial !== undefined) {
          emit({ type: "object-delta", port: "object", objectDelta: partial });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      refusal += event.delta ?? "";
    }
  }
  provisionalUsage.flush();

  if (refusal) {
    // Surface the refusal as a first-class event; the consumer completes with
    // the reserved `refusal` field instead of retrying against empty JSON.
    emit({ type: "refusal", refusal });
  }

  emit({
    type: "finish",
    data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
    usage,
  });
};
