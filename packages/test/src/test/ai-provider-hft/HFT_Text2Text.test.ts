/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HFT_Chat } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Chat";
import {
  clearPipelineCache,
  getPipelineCacheKey,
  loadTransformersSDK,
  pipelines,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";
import { HFT_TextGeneration } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_TextGeneration";

const modelLoadedAs = (pipeline: string) =>
  ({
    model_id: `hft-${pipeline}`,
    provider: "HF_TRANSFORMERS_ONNX",
    provider_config: { model_path: `test-org/${pipeline}-model`, pipeline },
  }) as never;

/** A pipeline that records what it was called with, as transformers.js would receive it. */
function recordingPipeline(): { pipeline: any; inputs: unknown[] } {
  const inputs: unknown[] = [];
  const tokenizer = Object.assign((text: string) => ({ input_ids: { dims: [1, text.length] } }), {
    all_special_ids: [] as number[],
    decode: () => "",
  });
  const pipeline: any = async (input: unknown) => {
    inputs.push(input);
    return [{ generated_text: "" }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = { generate: async () => ({ dims: [1, 1] }) };
  return { pipeline, inputs };
}

const emitNoop = (): undefined => undefined;
const signal = (): AbortSignal => new AbortController().signal;

beforeAll(async () => {
  await loadTransformersSDK();
});

afterEach(async () => {
  await clearPipelineCache();
});

describe("HFT_TextGeneration on an encoder-decoder model", () => {
  // transformers.js' text2text pipeline tokenizes the strings it is handed, so
  // chat messages reach its tokenizer as objects and the call throws.
  it("hands a text2text-generation pipeline the prompt as a string", async () => {
    const model = modelLoadedAs("text2text-generation");
    const fake = recordingPipeline();
    pipelines.set(getPipelineCacheKey(model), fake.pipeline);

    await HFT_TextGeneration(
      { model, prompt: "Summarize: cats." } as never,
      model,
      signal(),
      emitNoop
    );

    expect(fake.inputs).toEqual(["Summarize: cats."]);
  });

  it("still hands a text-generation pipeline chat messages, which apply its template", async () => {
    const model = modelLoadedAs("text-generation");
    const fake = recordingPipeline();
    pipelines.set(getPipelineCacheKey(model), fake.pipeline);

    await HFT_TextGeneration({ model, prompt: "Say hi." } as never, model, signal(), emitNoop);

    expect(fake.inputs).toEqual([[{ role: "user", content: "Say hi." }]]);
  });
});

describe("HFT_Chat on an encoder-decoder model", () => {
  it("refuses the conversation by name before loading anything", async () => {
    const model = modelLoadedAs("text2text-generation");
    const fake = recordingPipeline();
    pipelines.set(getPipelineCacheKey(model), fake.pipeline);

    await expect(
      HFT_Chat(
        { model, messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] } as never,
        model,
        signal(),
        emitNoop
      )
    ).rejects.toThrow(/text2text-generation model.*use TextGenerationTask/);
    expect(fake.inputs).toEqual([]);
  });
});
