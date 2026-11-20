/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
} from "@workglow/ai";
import {
  accumulateOpenAIChatStream,
  buildOpenAITools,
  mapOpenAIChatUsage,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import {
  createMetaChatStream,
  getClient,
  getMetaReasoningEffort,
  getModelName,
  metaSamplingParams,
} from "./Meta_Client";
import type { MetaModelConfig } from "./Meta_ModelSchema";

/**
 * The tools part of the request for a `toolChoice`.
 *
 * Meta accepts only `tool_choice: "auto"` and answers `400` to `none`,
 * `required` and a named function. `auto` is its default, so it is never sent.
 * `none` is honored by sending no tools, which is what it means. `required`
 * and a named tool cannot be honored at all, and are refused here rather than
 * sent as `auto`: a host that forced a call would otherwise get a reply with
 * none and no word of why.
 */
function toolsForChoice(input: ToolCallingTaskInput): Record<string, unknown> {
  const choice = input.toolChoice;
  if (choice === "none") return {};
  if (choice !== undefined && choice !== "auto") {
    throw new Error(
      `Meta supports only toolChoice "auto" (or "none"); "${choice}" cannot be honored.`
    );
  }
  const tools = buildOpenAITools(input.tools);
  return tools.length > 0 ? { tools } : {};
}

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Calls the Meta
 * chat-completions endpoint (OpenAI-compatible) with `stream: true` and
 * forwards delta events via {@link accumulateOpenAIChatStream}, which emits
 * `text-delta` and tool-call `object-delta` events plus a final empty
 * `finish`.
 *
 * Meta processes images only in `user` messages, so a tool result's images
 * ride in a user message after it. It returns no reasoning text on this
 * surface, so nothing is replayed between rounds.
 *
 * Defence-in-depth: each tool-call `object-delta` is filtered against
 * `input.tools` so a hallucinated function name never reaches the consumer.
 */
export const Meta_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  MetaModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const messages = toOpenAIMessages(input, { toolImagesInUserMessage: true });
  const reasoningEffort = getMetaReasoningEffort(model);

  const stream = await createMetaChatStream(
    client,
    {
      model: modelName,
      messages,
      ...(input.maxTokens !== undefined ? { max_completion_tokens: input.maxTokens } : {}),
      ...metaSamplingParams({ temperature: input.temperature }),
      ...toolsForChoice(input),
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    },
    signal
  );

  const usage = await accumulateOpenAIChatStream(
    stream,
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const validated = filterValidToolCalls(event.objectDelta as ToolCalls, input.tools);
        if (validated.length > 0) {
          emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
        }
        return;
      }
      emit(event);
    },
    mapOpenAIChatUsage,
    {
      promptText: messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n"),
    }
  );
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
