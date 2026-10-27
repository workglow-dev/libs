/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TextGenerationPipeline } from "@huggingface/transformers";
import type { AiProviderRunFn, TextRewriterTaskInput, TextRewriterTaskOutput } from "@workglow/ai";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  getPipeline,
  getPipelineCacheKey,
  loadTransformersSDK,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { createStreamingTextStreamer } from "./HFT_Streaming";
import { refuseHftVisionModel } from "./HFT_VisionLanguage";

export const HFT_TextRewriter: AiProviderRunFn<
  TextRewriterTaskInput,
  TextRewriterTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit) => {
  refuseHftVisionModel(model!, "HFT_TextRewriter");
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateText = (await getPipeline(model!, emit, {}, signal)) as TextGenerationPipeline;
    const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
    const streamer = createStreamingTextStreamer(
      generateText.tokenizer,
      (text) => emit({ type: "text-delta", port: "text", textDelta: text }),
      TextStreamer,
      emit
    );
    const stopping_criteria = new InterruptableStoppingCriteria();
    if (signal) {
      signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
    }

    const promptedText = (input.prompt ? input.prompt + "\n" : "") + input.text;

    await generateText(promptedText, {
      streamer,
      stopping_criteria: [stopping_criteria],
    });
    emit({ type: "finish", data: {} as TextRewriterTaskOutput });
  });
};
