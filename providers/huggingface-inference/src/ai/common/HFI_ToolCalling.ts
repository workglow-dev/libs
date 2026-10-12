/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ToolCallingTaskInput, ToolCallingTaskOutput } from "@workglow/ai";
import {
  accumulateOpenAIChatStream,
  buildOpenAITools,
  createEstimatedOutputUsageReporter,
  mapOpenAIChatUsage,
  mapOpenAIToolChoice,
} from "@workglow/ai/provider-utils";
import { toOpenAIMessages } from "@workglow/ai/worker";
import { getClient, getModelName, getProvider } from "./HFI_Client";
import { hfiReasoningParams } from "./HFI_EffortPolicy";
import type { HfInferenceModelConfig } from "./HFI_ModelSchema";

export const HFI_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  HfInferenceModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);
  const provider = getProvider(model);

  const tools = buildOpenAITools(input.tools);
  const messages = toOpenAIMessages(input, { toolImagesInUserMessage: true });
  const toolChoice = mapOpenAIToolChoice(input.toolChoice, false);
  const promptText = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n");

  const params: any = {
    model: modelName,
    messages,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    provider,
    stream: true,
    ...hfiReasoningParams(model),
  };
  if (toolChoice !== "none") {
    params.tools = tools;
    params.tool_choice = toolChoice;
  }

  // Estimate ↑ before the request so the CLI row shows spend during TTFB.
  createEstimatedOutputUsageReporter(emit).onPrompt(promptText);

  const stream = client.chatCompletionStream(params, { signal });

  // No `include_usage` opt-in here: the request is routed to a third-party
  // inference provider whose support for it varies. Usage is forwarded when the
  // upstream volunteers it on the terminal chunk, and stays absent otherwise.
  const usage = await accumulateOpenAIChatStream(stream, emit, mapOpenAIChatUsage, { promptText });
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
