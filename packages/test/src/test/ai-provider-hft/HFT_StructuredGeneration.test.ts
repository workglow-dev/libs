/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, StructuredGenerationTaskInput } from "@workglow/ai";
import {
    _testOnly,
    clearPipelineCache,
    getPipelineCacheKey,
    loadTransformersSDK,
    pipelines,
} from "@workglow/huggingface-transformers/ai-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { HFT_RUN_FNS } = _testOnly;

function findStructuredGenerationRunFn(): AiProviderRunFn {
  const registration = HFT_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("json-mode")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const model = {
  model_id: "hft-test-model",
  provider: "HF_TRANSFORMERS_ONNX",
  provider_config: { model_path: "test-org/fake-model", pipeline: "text-generation" },
} as never;
const cacheKey = getPipelineCacheKey(model);

const outputSchema = {
  type: "object",
  properties: {
    sentiment: { enum: ["positive", "negative", "neutral"] },
    topic: { enum: ["price", "quality", "delivery", "other"] },
  },
  required: ["sentiment", "topic"],
  additionalProperties: false,
};

const STREAMED_JSON = '{"sentiment":"negative","topic":"price"}';

interface GenerateCall {
  readonly logits_processor: unknown;
  readonly do_sample: unknown;
  readonly max_new_tokens: unknown;
}

function makeFakePipeline(): { pipeline: any; generateCalls: GenerateCall[] } {
  const generateCalls: GenerateCall[] = [];
  const tokenizer = {
    all_special_ids: [] as number[],
    // Direct vocab form accepted by StructuredOutputProcessor: one byte per id.
    tokens: Array.from({ length: 256 }, (_, id) => Uint8Array.of(id)),
    eos_token_id: 0,
    apply_chat_template: () => "<user>classify</user>\n<assistant>",
  };
  const pipeline: any = async (_prompt: unknown, opts: Record<string, unknown>) => {
    generateCalls.push({
      logits_processor: opts.logits_processor,
      do_sample: opts.do_sample,
      max_new_tokens: opts.max_new_tokens,
    });
    (
      opts.streamer as { callback_function?: (text: string) => void } | undefined
    )?.callback_function?.(STREAMED_JSON);
    return [{ generated_text: STREAMED_JSON }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = {};
  return { pipeline, generateCalls };
}

const emitNoop = (): undefined => undefined;

let fake: ReturnType<typeof makeFakePipeline>;
let runFn: AiProviderRunFn;

beforeAll(async () => {
  await loadTransformersSDK();
  runFn = findStructuredGenerationRunFn();
});

beforeEach(async () => {
  await clearPipelineCache();
  fake = makeFakePipeline();
  pipelines.set(cacheKey, fake.pipeline);
});

afterEach(async () => {
  await clearPipelineCache();
});

function asProcessorList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

describe("HFT_StructuredGeneration constrained decoding", () => {
  it("constrains generation with StructuredOutputProcessor from the output schema", async () => {
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
      maxTokens: 512,
    };

    await runFn(input, model, undefined as never, emitNoop);

    expect(fake.generateCalls).toHaveLength(1);
    const call = fake.generateCalls[0]!;
    expect(call.do_sample).toBe(false);
    expect(call.max_new_tokens).toBe(512);

    const processors = asProcessorList(call.logits_processor);
    expect(processors).toHaveLength(1);
    expect(processors[0]!.constructor.name).toBe("StructuredOutputProcessor");
  });

  it("still emits finish.data.object from the streamed JSON", async () => {
    const events: Array<{ type: string; data?: { object?: unknown } }> = [];
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
    };

    await runFn(input, model, undefined as never, (event) => {
      events.push(event as { type: string; data?: { object?: unknown } });
    });

    const finish = events.find((event) => event.type === "finish");
    expect(finish?.data?.object).toEqual({ sentiment: "negative", topic: "price" });
  });
});
