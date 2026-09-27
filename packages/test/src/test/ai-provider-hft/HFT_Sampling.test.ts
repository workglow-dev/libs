/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ChatMessage } from "@workglow/ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HFT_Chat } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Chat";
import {
  clearPipelineCache,
  getPipelineCacheKey,
  loadTransformersSDK,
  pipelines,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";
import { hftSamplingOptions } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Sampling";
import { HFT_TextGeneration } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_TextGeneration";
import { HFT_ToolCalling } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_ToolCalling";

const model = {
  model_id: "hft-test-model",
  provider: "HF_TRANSFORMERS_ONNX",
  provider_config: { model_path: "test-org/fake-model", pipeline: "text-generation" },
} as never;
const cacheKey = getPipelineCacheKey(model);

/**
 * The sampling keys `generate()` received. Presence is recorded apart from value
 * because an absent key is what defers to the model's generation config, and
 * transformers.js treats that differently from any value sent for it.
 */
interface SamplingCall {
  readonly hasDoSample: boolean;
  readonly doSample: unknown;
  readonly hasTemperature: boolean;
  readonly temperature: unknown;
}

function makeFakePipeline(): { pipeline: any; calls: SamplingCall[] } {
  const calls: SamplingCall[] = [];
  const tokenizer = Object.assign((text: string) => ({ input_ids: { dims: [1, text.length] } }), {
    all_special_ids: [] as number[],
    apply_chat_template: () => "<user>hi</user>\n<assistant>",
    decode: () => "",
  });
  // Both routes end here: the pipeline forwards its options to
  // `model.generate`, and the chat run-fn calls `model.generate` directly.
  const hfModel = {
    generate: async (args: Record<string, any>) => {
      calls.push({
        hasDoSample: "do_sample" in args,
        doSample: args.do_sample,
        hasTemperature: "temperature" in args,
        temperature: args.temperature,
      });
      return { dims: [1, args.input_ids.dims[1]] };
    },
  };
  const pipeline: any = async (_promptOrMessages: unknown, opts: Record<string, unknown>) => {
    await hfModel.generate({ ...tokenizer("prompt"), ...opts });
    return [{ generated_text: "" }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = hfModel;
  return { pipeline, calls };
}

const emitNoop = (): undefined => undefined;
const signal = (): AbortSignal => new AbortController().signal;

let fake: ReturnType<typeof makeFakePipeline>;

beforeAll(async () => {
  await loadTransformersSDK();
});

beforeEach(async () => {
  await clearPipelineCache();
  fake = makeFakePipeline();
  pipelines.set(cacheKey, fake.pipeline);
});

afterEach(async () => {
  await clearPipelineCache();
});

describe("hftSamplingOptions", () => {
  it("samples at a positive temperature", () => {
    expect(hftSamplingOptions(0.9, "greedy")).toEqual({ do_sample: true, temperature: 0.9 });
    expect(hftSamplingOptions(0.9, "model-default")).toEqual({
      do_sample: true,
      temperature: 0.9,
    });
  });

  it("decodes greedily at temperature 0", () => {
    expect(hftSamplingOptions(0, "greedy")).toEqual({ do_sample: false });
    expect(hftSamplingOptions(0, "model-default")).toEqual({ do_sample: false });
  });

  it("applies the run-fn's own rule when no temperature is given", () => {
    expect(hftSamplingOptions(undefined, "greedy")).toEqual({ do_sample: false });
    expect(hftSamplingOptions(undefined, "model-default")).toEqual({});
  });
});

const userMessage = (text: string): ChatMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

interface RunFnCase {
  readonly name: string;
  readonly runFn: AiProviderRunFn<any, any, any>;
  readonly input: (temperature: number | undefined) => Record<string, unknown>;
  /** What an unset temperature sends: greedy, or nothing at all. */
  readonly whenUnset: "greedy" | "model-default";
}

const RUN_FN_CASES: readonly RunFnCase[] = [
  {
    name: "HFT_TextGeneration",
    runFn: HFT_TextGeneration,
    input: (temperature) => ({ model, prompt: "Say hi.", temperature }),
    whenUnset: "greedy",
  },
  {
    name: "HFT_Chat",
    runFn: HFT_Chat,
    input: (temperature) => ({ model, messages: [userMessage("Say hi.")], temperature }),
    whenUnset: "model-default",
  },
  {
    name: "HFT_ToolCalling",
    runFn: HFT_ToolCalling,
    input: (temperature) => ({
      model,
      prompt: "What is the weather?",
      tools: [{ name: "get_weather", description: "d", inputSchema: { type: "object" } }],
      temperature,
    }),
    whenUnset: "model-default",
  },
];

// `temperature` only reaches transformers.js' logits warpers under
// `do_sample`, so forwarding one without the other silently drops it.
describe.each(RUN_FN_CASES)("$name temperature", ({ runFn, input, whenUnset }) => {
  async function run(temperature: number | undefined): Promise<SamplingCall> {
    await runFn(input(temperature) as never, model, signal(), emitNoop);
    expect(fake.calls).toHaveLength(1);
    return fake.calls[0]!;
  }

  it(`is ${whenUnset} when no temperature is given`, async () => {
    const call = await run(undefined);
    expect(call.hasTemperature).toBe(false);
    if (whenUnset === "greedy") {
      expect(call.doSample).toBe(false);
    } else {
      expect(call.hasDoSample).toBe(false);
    }
  });

  it("samples when the caller sets a non-zero temperature", async () => {
    const call = await run(0.9);
    expect(call.doSample).toBe(true);
    expect(call.temperature).toBe(0.9);
  });

  it("stays greedy when the caller sets temperature 0", async () => {
    const call = await run(0);
    expect(call.doSample).toBe(false);
  });
});
