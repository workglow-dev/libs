/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
} from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  buildResponsesInput,
  buildResponsesTools,
  createEstimatedOutputUsageReporter,
  mapResponsesToolChoice,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import { mergeOpenAICheckpointPrefix } from "./OpenAI_CacheCheckpoint";
import { finalizeResponsesRequest, getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Calls the OpenAI
 * Responses endpoint with `stream: true` and forwards delta events via
 * {@link accumulateOpenAIResponsesStream}, which emits `text-delta` and tool-call
 * `object-delta` events plus a final empty `finish`.
 *
 * Defence-in-depth: each tool-call `object-delta` is filtered against the
 * effective tool declarations (the caller's tools, or the checkpoint prefix's
 * on fallback) so a hallucinated function name never reaches the consumer.
 */
export const OpenAI_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  // Checkpoint consumption: replay the prefix content ahead of the tail so the
  // request's literal prefix matches the warm-up and hits the automatic
  // server-side prompt cache. The effective tool declarations come from the
  // merge too — the caller's tools win, and an empty list falls back to the
  // prefix's so the warmed tool segment (and its prompt_cache_key) is shared.
  const merged = mergeOpenAICheckpointPrefix(sessionContext, input);
  const toolDefinitions = merged?.tools ?? input.tools;
  const replay =
    (model?.provider_config as { replay_reasoning?: boolean } | undefined)?.replay_reasoning !==
    false;
  const tools = buildResponsesTools(toolDefinitions);
  const { input: responsesInput, instructions } = buildResponsesInput({
    messages: toOpenAIMessages(
      merged
        ? ({
            ...input,
            messages: merged.messages,
            systemPrompt: merged.systemPrompt,
            prompt: "",
          } as ToolCallingTaskInput)
        : input,
      replay ? { nativeTurnProvider: "openai" } : {}
    ),
  });
  const toolChoice = mapResponsesToolChoice(input.toolChoice);

  const params: Record<string, unknown> = {
    model: modelName,
    input: responsesInput,
    tools,
    tool_choice: toolChoice,
  };
  if (instructions !== undefined) params.instructions = instructions;
  if (input.maxTokens !== undefined) params.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined) params.temperature = input.temperature;
  finalizeResponsesRequest(model, params);
  // A reasoning model starts its thinking over every round unless it is handed
  // its encrypted reasoning back; the items come back on `nativeTurn`.
  const reasoning = params.reasoning as { effort?: string } | undefined;
  if (replay && reasoning !== undefined && reasoning.effort !== "none") {
    params.include = ["reasoning.encrypted_content"];
  }

  const promptText = promptTextForResponsesUsageEstimate(params);
  createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

  const stream = await client.responses.create(
    { ...params, stream: true } as Parameters<typeof client.responses.create>[0],
    { signal }
  );

  const usage = await accumulateOpenAIResponsesStream<ToolCallingTaskOutput>(
    stream as AsyncIterable<unknown>,
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const validated = filterValidToolCalls(event.objectDelta as ToolCalls, toolDefinitions);
        if (validated.length > 0) {
          emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
        }
        return;
      }
      emit(event);
    },
    { promptText, nativeTurnProvider: replay ? "openai" : undefined }
  );
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
