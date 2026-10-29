/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextSummaryTaskInput, TextSummaryTaskOutput } from "@workglow/ai";
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { createGeminiClient, getModelName, resolveThinkingConfig } from "./Gemini_Client";
import type { GeminiModelConfig } from "./Gemini_ModelSchema";
import { emitGeminiRefusal, geminiRefusalCategory } from "./Gemini_Refusal";
import { mapGeminiUsage } from "./Gemini_Usage";

export const Gemini_TextSummary_Stream: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  GeminiModelConfig
> = async (input, model, signal, emit) => {
  const ai = await createGeminiClient(model);

  // This task sets no output cap, so there is nothing to pad for the budget.
  // `chunk.text` below skips thought parts, so thinking stays out of the text.
  const { thinkingConfig } = resolveThinkingConfig(model, undefined);

  const result = await ai.models.generateContentStream({
    model: getModelName(model),
    contents: [{ role: "user", parts: [{ text: input.text }] }],
    config: {
      abortSignal: signal ?? undefined,
      systemInstruction: "Summarize the following text concisely.",
      ...(thinkingConfig !== undefined && { thinkingConfig }),
    },
  });

  let refusalCategory: string | undefined;
  let lastUsageMetadata: unknown;
  const snapshotUsage = createUsageSnapshotEmitter(emit);
  for await (const chunk of result) {
    lastUsageMetadata = chunk.usageMetadata ?? lastUsageMetadata;
    snapshotUsage(mapGeminiUsage(lastUsageMetadata));
    const text = chunk.text;
    if (text) {
      emit({ type: "text-delta", port: "text", textDelta: text });
    }
    refusalCategory = refusalCategory ?? geminiRefusalCategory(chunk);
  }
  emitGeminiRefusal(emit, refusalCategory);
  emit({
    type: "finish",
    data: {} as TextSummaryTaskOutput,
    usage: mapGeminiUsage(lastUsageMetadata),
  });
};
