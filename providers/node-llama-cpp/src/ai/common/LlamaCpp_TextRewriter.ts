/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextRewriterTaskInput, TextRewriterTaskOutput } from "@workglow/ai";
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

export const LlamaCpp_TextRewriter_Stream: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  LlamaCppModelConfig
> = async (input, model, signal, emit) => {
  if (!model) throw new Error("Model config is required for TextRewriterTask.");

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
          systemPrompt: input.prompt,
        });
        try {
          for await (const e of streamFromSession<TextRewriterTaskOutput>(
            (onTextChunk) => {
              return session.prompt(input.text, {
                signal,
                onTextChunk,
                ...llamaCppSeedPromptSpread(model.provider_config),
                ...llamaCppThoughtBudgetOption(model),
              });
            },
            signal,
            { promptText: `${input.prompt}\n${input.text}` }
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
