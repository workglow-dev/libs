/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
} from "@workglow/ai";
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import { getClient, getMaxTokens, getModelName } from "./Anthropic_Client";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import {
  anthropicJsonSchemaFormat,
  anthropicSupportsOutputFormat,
  toAnthropicOutputSchema,
} from "./Anthropic_OutputFormat";
import { maybeEmitAnthropicRefusal } from "./Anthropic_Refusal";
import { anthropicAcceptsForcedToolChoice } from "./Anthropic_RequestParams";
import { applyAnthropicThinkingParams } from "./Anthropic_Thinking";
import { createAnthropicUsageCollector } from "./Anthropic_Usage";

/**
 * Streaming run-fn for the `["text.generation", "json-mode"]` capability.
 *
 * Two routes to the same output. Where the model accepts it, native structured
 * outputs: `output_config.format` constrains the reply to the schema as it is
 * generated, and the JSON arrives as ordinary text. Elsewhere — an older model,
 * or a schema the decoder cannot express — a synthetic `structured_output`
 * tool, whose arguments are the object.
 *
 * Either way the deltas feed an incremental parser, yielded as `object-delta`
 * for consumers that want progressive updates, and the `finish` event carries
 * the parsed object in `finish.data.object` per the streaming-convention
 * exception for structured generation: it is the definitive object
 * `StructuredGenerationTask` validates against the full schema and retries on.
 */
export const Anthropic_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  AnthropicModelConfig
> = async (input, model, signal, emit, outputSchema) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const schema = input.outputSchema ?? outputSchema;

  const native = anthropicSupportsOutputFormat(model) ? toAnthropicOutputSchema(schema) : undefined;
  if (native !== undefined) {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: [{ role: "user", content: input.prompt as string }],
      output_config: { format: anthropicJsonSchemaFormat(native) },
      max_tokens: getMaxTokens(input, model),
    };
    // Merges effort into `output_config` beside the format rather than over it.
    applyAnthropicThinkingParams(params, model);

    const stream = (client.messages.stream as (p: unknown, o: unknown) => AsyncIterable<unknown>)(
      params,
      { signal }
    );
    const json = createPartialJsonStream();
    const usageCollector = createAnthropicUsageCollector();
    const snapshotUsage = createUsageSnapshotEmitter(emit);
    for await (const event of stream) {
      usageCollector.observe(event);
      snapshotUsage(usageCollector.result());
      maybeEmitAnthropicRefusal(event, emit);
      const e = event as { type: string; delta?: { type?: string; text?: string } };
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        const partial = json.push(e.delta.text ?? "");
        if (partial !== undefined) {
          emit({ type: "object-delta", port: "object", objectDelta: partial });
        }
      }
    }
    emit({
      type: "finish",
      data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
      usage: usageCollector.result(),
    });
    return;
  }

  // Newer models reject a forced tool choice with a 400. There the tool is
  // offered on `auto` with an instruction to call it, and a reply that answers
  // in text instead is still read for its JSON below.
  const forced = anthropicAcceptsForcedToolChoice(model);
  const params: Record<string, unknown> = {
    model: modelName,
    messages: [{ role: "user", content: input.prompt as string }],
    tools: [
      {
        name: "structured_output",
        description: "Output structured data conforming to the schema",
        input_schema: schema as any,
      },
    ],
    tool_choice: forced
      ? { type: "tool" as const, name: "structured_output" }
      : { type: "auto" as const, disable_parallel_tool_use: true },
    max_tokens: getMaxTokens(input, model),
  };
  if (!forced) {
    params.system =
      "Answer by calling the structured_output tool exactly once, with arguments " +
      "conforming to its schema. Do not answer in text.";
  }
  applyAnthropicThinkingParams(params, model);

  const stream = (client.messages.stream as (p: unknown, o: unknown) => AsyncIterable<unknown>)(
    params,
    { signal }
  );

  const json = createPartialJsonStream();
  let sawToolInput = false;
  const text = forced ? undefined : createPartialJsonStream({ skipPreamble: true });
  const usageCollector = createAnthropicUsageCollector();
  const snapshotUsage = createUsageSnapshotEmitter(emit);
  for await (const event of stream) {
    usageCollector.observe(event);
    snapshotUsage(usageCollector.result());
    maybeEmitAnthropicRefusal(event, emit);
    const e = event as {
      type: string;
      delta?: { type?: string; partial_json?: string; text?: string };
    };
    if (text !== undefined && e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      text.push(e.delta.text ?? "");
    }
    if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      sawToolInput = true;
      const partial = json.push(e.delta.partial_json ?? "");
      if (partial !== undefined) {
        emit({ type: "object-delta", port: "object", objectDelta: partial });
      }
    }
  }

  emit({
    type: "finish",
    data: {
      object: text !== undefined && !sawToolInput ? text.finishObject() : json.finishObject(),
    } as StructuredGenerationTaskOutput,
    usage: usageCollector.result(),
  });
};
