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
  readonly temperature: unknown;
}

interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

function makeFakePipeline(): {
  pipeline: any;
  generateCalls: GenerateCall[];
  chatTemplateCalls: ChatMessage[][];
} {
  const generateCalls: GenerateCall[] = [];
  const chatTemplateCalls: ChatMessage[][] = [];
  const tokenizer = {
    all_special_ids: [] as number[],
    // Direct vocab form accepted by StructuredOutputProcessor: one byte per id.
    tokens: Array.from({ length: 256 }, (_, id) => Uint8Array.of(id)),
    eos_token_id: 0,
    // Records what the run-fn asked to be templated; the rendered string it
    // returns is irrelevant to every assertion below.
    apply_chat_template: (messages: ChatMessage[]) => {
      chatTemplateCalls.push(messages);
      return "<user>classify</user>\n<assistant>";
    },
  };
  const pipeline: any = async (_prompt: unknown, opts: Record<string, unknown>) => {
    generateCalls.push({
      logits_processor: opts.logits_processor,
      do_sample: opts.do_sample,
      max_new_tokens: opts.max_new_tokens,
      temperature: opts.temperature,
    });
    (
      opts.streamer as { callback_function?: (text: string) => void } | undefined
    )?.callback_function?.(STREAMED_JSON);
    return [{ generated_text: STREAMED_JSON }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = {};
  return { pipeline, generateCalls, chatTemplateCalls };
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

  // The logits processor constrains decode to a schema-VALID SHAPE, so a model
  // that never saw the field names still returns an object that validates and
  // the task's retry loop never fires. The schema has to reach the prompt too.
  it("sends the output schema and a json instruction in the prompt", async () => {
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
    };

    await runFn(input, model, undefined as never, emitNoop);

    expect(fake.chatTemplateCalls).toHaveLength(1);
    const messages = fake.chatTemplateCalls[0]!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");

    const content = messages[0]!.content;
    expect(content).toContain("Classify this feedback: The product is way too expensive.");
    expect(content).toContain("json");
    expect(content).toContain(JSON.stringify(outputSchema));
    // Field names and their allowed values are what a bare prompt loses.
    expect(content).toContain("sentiment");
    expect(content).toContain("delivery");
  });

  // `temperature` only reaches transformers.js' logits warpers under
  // `do_sample`, so forwarding one without the other silently drops it.
  it("decodes greedily when no temperature is given", async () => {
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
    };

    await runFn(input, model, undefined as never, emitNoop);

    expect(fake.generateCalls[0]!.do_sample).toBe(false);
  });

  it("samples when the caller sets a non-zero temperature", async () => {
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
      temperature: 0.9,
    };

    await runFn(input, model, undefined as never, emitNoop);

    const call = fake.generateCalls[0]!;
    expect(call.do_sample).toBe(true);
    expect(call.temperature).toBe(0.9);
  });

  it("stays greedy when the caller sets temperature 0", async () => {
    const input: StructuredGenerationTaskInput = {
      model,
      prompt: "Classify this feedback: The product is way too expensive.",
      outputSchema,
      temperature: 0,
    };

    await runFn(input, model, undefined as never, emitNoop);

    expect(fake.generateCalls[0]!.do_sample).toBe(false);
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
