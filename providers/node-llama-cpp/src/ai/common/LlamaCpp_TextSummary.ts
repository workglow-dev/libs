/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextSummaryTaskInput, TextSummaryTaskOutput } from "@workglow/ai";
import { llamaCppThoughtBudgetOption } from "./LlamaCpp_EffortPolicy";
import type { LlamaCppModelConfig } from "./LlamaCpp_ModelSchema";
import {
  getActualModelPath,
  getOrCreateTextContext,
  llamaCppChatSessionConstructorSpread,
  llamaCppSeedPromptSpread,
  loadSdk,
  streamFromSession,
  withModelInUse,
  withSequence,
} from "./LlamaCpp_Runtime";

export const LlamaCpp_TextSummary_Stream: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  LlamaCppModelConfig
> = async (input, model, signal, emit) => {
  if (!model) throw new Error("Model config is required for TextSummaryTask.");

  const { LlamaChatSession } = await loadSdk();
  const modelPath = getActualModelPath(model);

  await withModelInUse(modelPath, async () => {
    const context = await getOrCreateTextContext(model);
    await withSequence(
      context,
      async (sequence) => {
        const session = new LlamaChatSession({
          contextSequence: sequence,
          ...llamaCppChatSessionConstructorSpread(model),
          systemPrompt: "Summarize the following text concisely, preserving the key points.",
        });
        try {
          for await (const e of streamFromSession<TextSummaryTaskOutput>(
            (onTextChunk) => {
              return session.prompt(input.text, {
                signal,
                onTextChunk,
                ...llamaCppSeedPromptSpread(model.provider_config),
                ...llamaCppThoughtBudgetOption(model),
              });
            },
            signal,
            {
              promptText: `Summarize the following text concisely, preserving the key points.\n${input.text}`,
            }
          )) {
            emit(e);
          }
        } finally {
          try {
            session.dispose({ disposeSequence: false });
          } catch {}
        }
      },
      { signal }
    );
  });
};
