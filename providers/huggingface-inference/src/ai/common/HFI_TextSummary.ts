/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  Usage,
} from "@workglow/ai";
import {
  createEstimatedOutputUsageReporter,
  mapOpenAIChatUsage,
} from "@workglow/ai/provider-utils";
import { getClient, getModelName, getProvider } from "./HFI_Client";
import { hfiReasoningParams } from "./HFI_EffortPolicy";
import type { HfInferenceModelConfig } from "./HFI_ModelSchema";

export const HFI_TextSummary_Stream: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  HfInferenceModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);
  const provider = getProvider(model);

  const provisionalUsage = createEstimatedOutputUsageReporter(emit);
  provisionalUsage.onPrompt(
    `Summarize the following text concisely.\n${typeof input.text === "string" ? input.text : ""}`
  );

  const stream = client.chatCompletionStream(
    {
      model: modelName,
      messages: [
        { role: "system", content: "Summarize the following text concisely." },
        { role: "user", content: input.text },
      ],
      provider,
      ...hfiReasoningParams(model),
    },
    { signal }
  );

  // The usage-bearing chunk arrives last with an empty `choices` array, so it
  // is read before the delta guard below rather than inside it. Whether it
  // arrives at all is up to the third-party provider the request is routed to;
  // when it does not, `usage` stays undefined and the estimate above remains
  // the only feedback.
  let usage: Usage | undefined;
  for await (const chunk of stream) {
    usage = mapOpenAIChatUsage((chunk as { usage?: unknown }).usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      provisionalUsage.onText(delta);
      emit({ type: "text-delta", port: "text", textDelta: delta });
    }
  }
  provisionalUsage.flush();
  emit({ type: "finish", data: {} as TextSummaryTaskOutput, usage });
};
