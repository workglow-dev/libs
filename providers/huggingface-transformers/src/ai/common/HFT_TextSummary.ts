/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SummarizationPipeline } from "@huggingface/transformers";
import type { AiProviderRunFn, TextSummaryTaskInput, TextSummaryTaskOutput } from "@workglow/ai";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  getPipeline,
  getPipelineCacheKey,
  loadTransformersSDK,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { createStreamingTextStreamer } from "./HFT_Streaming";
import { refuseHftVisionModel } from "./HFT_VisionLanguage";

export const HFT_TextSummary: AiProviderRunFn<
  TextSummaryTaskInput,
  TextSummaryTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit) => {
  refuseHftVisionModel(model!, "HFT_TextSummary");
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateSummary = (await getPipeline(model!, emit, {}, signal)) as SummarizationPipeline;
    const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
    const streamer = createStreamingTextStreamer(
      generateSummary.tokenizer,
      (text) => emit({ type: "text-delta", port: "text", textDelta: text }),
      TextStreamer,
      emit
    );
    const stopping_criteria = new InterruptableStoppingCriteria();
    if (signal) {
      signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
    }

    await generateSummary(input.text, {
      streamer,
      stopping_criteria: [stopping_criteria],
    } as any);
    emit({ type: "finish", data: {} as TextSummaryTaskOutput });
  });
};
