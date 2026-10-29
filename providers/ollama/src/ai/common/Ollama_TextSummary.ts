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
import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import { ollamaThinkParam } from "./Ollama_EffortPolicy";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";
import { getOllamaModelName } from "./Ollama_ModelUtil";
import { mapOllamaUsage } from "./Ollama_Usage";

type GetClient = (model: OllamaModelConfig | undefined) => Promise<any>;

export function createOllamaTextSummaryStream(
  getClient: GetClient
): AiProviderRunFn<TextSummaryTaskInput, TextSummaryTaskOutput, OllamaModelConfig> {
  return async (input, model, signal, emit) => {
    const client = await getClient(model);
    const modelName = getOllamaModelName(model);

    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(
      `Summarize the following text concisely.\n${typeof input.text === "string" ? input.text : ""}`
    );

    const stream = await client.chat({
      model: modelName,
      messages: [
        { role: "system", content: "Summarize the following text concisely." },
        { role: "user", content: input.text },
      ],
      ...ollamaThinkParam(model),
      stream: true,
    });

    const onAbort = (): void => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let usage: Usage | undefined;
      for await (const chunk of stream) {
        usage = mapOllamaUsage(chunk) ?? usage;
        const delta = chunk.message.content;
        if (delta) {
          provisionalUsage.onText(delta);
          emit({ type: "text-delta", port: "text", textDelta: delta });
        }
      }
      provisionalUsage.flush();
      emit({ type: "finish", data: {} as TextSummaryTaskOutput, usage });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
