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
import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import { llamaCppThoughtBudgetOption } from "./LlamaCpp_EffortPolicy";
import type { LlamaCppModelConfig } from "./LlamaCpp_ModelSchema";
import {
  createDisposableTextContext,
  getActualModelPath,
  getLlamaCppSdk,
  getLlamaInstance,
  llamaCppChatSessionConstructorSpread,
  llamaCppSeedPromptSpread,
  loadSdk,
  withModelInUse,
  withSequence,
} from "./LlamaCpp_Runtime";

export const LlamaCpp_StructuredGeneration_Stream: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  LlamaCppModelConfig
> = async (input, model, signal, emit) => {
  if (!model) throw new Error("Model config is required for StructuredGenerationTask.");

  await loadSdk();

  const modelPath = getActualModelPath(model);

  await withModelInUse(modelPath, async () => {
    const llama = await getLlamaInstance();
    // A FRESH context per generation (disposed below), not the shared cached one:
    // reusing one context across independent structured calls races the prior
    // call's sequence teardown, which throws "No sequences left" or segfaults on
    // some architectures (Gemma). See createDisposableTextContext.
    const context = await createDisposableTextContext(model);

    try {
      const grammar = await llama.createGrammarForJsonSchema(input.outputSchema as any);
      await withSequence(
        context,
        async (sequence) => {
          const { LlamaChatSession } = getLlamaCppSdk();
          const session = new LlamaChatSession({
            contextSequence: sequence,
            ...llamaCppChatSessionConstructorSpread(model),
          });

          const queue: string[] = [];
          let isComplete = false;
          let completionError: unknown;
          let resolveWait: (() => void) | null = null;

          const notifyWaiter = () => {
            resolveWait?.();
            resolveWait = null;
          };

          const provisionalUsage = createEstimatedOutputUsageReporter(emit);
          provisionalUsage.onPrompt(input.prompt as string);

          const json = createPartialJsonStream();
          const promptPromise = session
            .prompt(input.prompt as string, {
              signal,
              grammar,
              ...llamaCppSeedPromptSpread(model.provider_config),
              onTextChunk: (chunk: string) => {
                queue.push(chunk);
                provisionalUsage.onText(chunk);
                notifyWaiter();
              },
              ...(input.temperature !== undefined && { temperature: input.temperature }),
              ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
              ...llamaCppThoughtBudgetOption(model),
            })
            .then(() => {
              isComplete = true;
              notifyWaiter();
            })
            .catch((err: unknown) => {
              completionError = err;
              isComplete = true;
              notifyWaiter();
            });

          try {
            while (true) {
              while (queue.length > 0) {
                const chunk = queue.shift()!;
                const partial = json.push(chunk);
                if (partial !== undefined) {
                  emit({ type: "object-delta", port: "object", objectDelta: partial });
                }
              }
              if (isComplete) break;
              await new Promise<void>((r) => {
                resolveWait = r;
              });
            }
            while (queue.length > 0) {
              const chunk = queue.shift()!;
              const partial = json.push(chunk);
              if (partial !== undefined) {
                emit({ type: "object-delta", port: "object", objectDelta: partial });
              }
            }
          } finally {
            await promptPromise.catch(() => {});
            try {
              session.dispose({ disposeSequence: false });
            } catch {}
          }

          if (completionError) {
            if (signal.aborted) return;
            throw completionError;
          }

          provisionalUsage.flush();
          emit({
            type: "finish",
            data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
          });
        },
        { signal }
      );
    } finally {
      // Dispose the fresh context (frees its sequence pool + KV cache) before the
      // next generation, so no teardown is left in flight to race/segfault.
      await context.dispose().catch(() => {});
    }
  });
};
