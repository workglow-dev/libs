/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, TextGenerationPipeline } from "@huggingface/transformers";
import type { ResponseFormat } from "@huggingface/transformers-structured-output";
import type {
  AiProviderRunFn,
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
} from "@workglow/ai";
import { promptWithJsonSchema } from "@workglow/ai/provider-utils";
import { createPartialJsonStream } from "@workglow/util/worker";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  getPipeline,
  getPipelineCacheKey,
  loadTransformersSDK,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { createStreamingTextStreamer } from "./HFT_Streaming";

/**
 * Decode is greedy unless the caller asks for sampling: `temperature` only
 * reaches transformers.js' logits warpers under `do_sample`, so the two are
 * derived from one another rather than set independently.
 */
export const HFT_StructuredGeneration: AiProviderRunFn<
  StructuredGenerationTaskInput,
  StructuredGenerationTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit) => {
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateText = (await getPipeline(model!, emit, {}, signal)) as TextGenerationPipeline;
    const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
    const prompt = promptWithJsonSchema(input.prompt, input.outputSchema);

    const messages: Message[] = [{ role: "user", content: prompt }];

    const formattedPrompt = generateText.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    }) as string;

    // A state machine skips <think>...</think> blocks and strips special tokens
    // from each delta, so no full-string regex ever runs over the accumulated
    // output. What survives is fed straight into the incremental JSON parser,
    // which discards any remaining preamble ahead of the first '{'.
    let inThinkBlock = false;
    const json = createPartialJsonStream({ skipPreamble: true });

    const streamer = createStreamingTextStreamer(
      generateText.tokenizer,
      (delta) => {
        let cleanedDelta = "";
        let remaining = delta;
        while (remaining.length > 0) {
          if (inThinkBlock) {
            const closeIdx = remaining.indexOf("</think>");
            if (closeIdx !== -1) {
              inThinkBlock = false;
              remaining = remaining.slice(closeIdx + "</think>".length);
            } else {
              remaining = ""; // still inside think block; discard rest of delta
            }
          } else {
            const openIdx = remaining.indexOf("<think>");
            if (openIdx !== -1) {
              cleanedDelta += remaining.slice(0, openIdx).replace(/<\|[a-z_]+\|>/g, "");
              inThinkBlock = true;
              remaining = remaining.slice(openIdx + "<think>".length);
            } else {
              cleanedDelta += remaining.replace(/<\|[a-z_]+\|>/g, "");
              remaining = "";
            }
          }
        }

        const partial = json.push(cleanedDelta);
        if (partial !== undefined) {
          emit({ type: "object-delta", port: "object", objectDelta: partial });
          return;
        }
        emit({ type: "text-delta", port: "text", textDelta: delta });
      },
      TextStreamer,
      emit
    );
    const stopping_criteria = new InterruptableStoppingCriteria();
    if (signal) {
      signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
    }

    // Prompt injection tells the model what the fields mean; the logits
    // processor is what actually constrains decode to valid JSON for the schema.
    // Loaded dynamically because it statically imports the transformers SDK,
    // which the main-thread `/ai` entry must not pull in.
    const { StructuredOutputProcessor } =
      await import("@huggingface/transformers-structured-output");
    const processor = new StructuredOutputProcessor(generateText.tokenizer, {
      type: "json_schema",
      json_schema: input.outputSchema,
    } as Extract<ResponseFormat, { type: "json_schema" }>);

    const temperature = input.temperature ?? 0;

    await generateText(formattedPrompt, {
      max_new_tokens: input.maxTokens ?? 1024,
      temperature,
      do_sample: temperature > 0,
      return_full_text: false,
      streamer,
      stopping_criteria: [stopping_criteria],
      logits_processor: processor,
    });

    emit({
      type: "finish",
      data: { object: json.finishObject() } as StructuredGenerationTaskOutput,
    });
  });
};
