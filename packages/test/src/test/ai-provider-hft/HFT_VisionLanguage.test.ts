/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiChatProviderInput,
  AiSessionContext,
  ChatMessage,
  TextGenerationTaskInput,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
} from "@workglow/ai";
import { accumulatingEmit } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HFT_CacheCheckpoint } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_CacheCheckpoint";
import { inferHftCapabilities } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Capabilities";
import { HFT_Chat } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Chat";
import {
  clearPipelineCache,
  getHftSession,
  getPipeline,
  getPipelineCacheKey,
  HFT_NULL_PROCESSOR_PREFIX,
  loadTransformersSDK,
  pipelines,
  removeCachedPipeline,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";
import { HFT_StructuredGeneration } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_StructuredGeneration";
import { HFT_TextGeneration } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_TextGeneration";
import {
  buildHFTMessages,
  HFT_ToolCalling,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_ToolCalling";
import {
  buildHftVisionMessages,
  HFT_TOOL_IMAGES_INTRO,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_VisionLanguage";
import type { FakeVisionModel } from "./fakeVisionModel";
import { fakeVisionModel, spyOnRawImageDecode } from "./fakeVisionModel";

type TransformersSDK = Awaited<ReturnType<typeof loadTransformersSDK>>;

// "qwen" in the path selects the Hermes-style `<tool_call>` parser family.
const vlmModel = {
  model_id: "hft-test-qwen-vl",
  provider: "HF_TRANSFORMERS_ONNX",
  provider_config: {
    model_path: "test-org/qwen-vl-fake",
    pipeline: "image-text-to-text",
    dtype: "q4",
    device: "webgpu",
    revision: "v1",
  },
} as never;
const cacheKey = getPipelineCacheKey(vlmModel);

/** Base64 PNGs whose bytes differ, so each one is recognisable where it lands. */
const PHOTO = { type: "image", mimeType: "image/png", data: "UEhPVE8tYnl0ZXM=" } as const;
const CHART = { type: "image", mimeType: "image/jpeg", data: "Q0hBUlQtYnl0ZXM=" } as const;
const SCAN = { type: "image", mimeType: "image/png", data: "U0NBTi1ieXRlcw==" } as const;

const weatherTool = {
  name: "get_weather",
  description: "Look up the weather",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
} as const;

let sdk: TransformersSDK;
let restoreDecode: () => void;
let fake: FakeVisionModel;

beforeAll(async () => {
  sdk = await loadTransformersSDK();
});

beforeEach(async () => {
  await clearPipelineCache();
  restoreDecode = spyOnRawImageDecode(sdk);
  fake = fakeVisionModel();
  pipelines.set(cacheKey, fake.vlm as never);
});

afterEach(async () => {
  restoreDecode();
  vi.restoreAllMocks();
  await clearPipelineCache();
});

/** A conversation with an image from the user and one from the tool it called. */
function imageHistory(): ChatMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "What city is this, and its weather?" }, PHOTO],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "18C and cloudy, chart attached." }, CHART],
          is_error: undefined,
        },
      ],
    },
  ];
}

async function runToolCalling(
  input: Partial<ToolCallingTaskInput>,
  sessionContext?: AiSessionContext
): Promise<{ events: StreamEvent<ToolCallingTaskOutput>[]; output: ToolCallingTaskOutput }> {
  const events: StreamEvent<ToolCallingTaskOutput>[] = [];
  const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
  await HFT_ToolCalling(
    { model: vlmModel, prompt: "", tools: [weatherTool], toolChoice: "auto", ...input } as never,
    vlmModel,
    new AbortController().signal,
    (event) => {
      events.push(event);
      accumulator.emit(event);
    },
    undefined,
    sessionContext
  );
  return { events, output: accumulator.result() };
}

function textOn(events: ReadonlyArray<StreamEvent<never>>, port: string): string {
  return events
    .filter((e) => e.type === "text-delta" && (e as { port: string }).port === port)
    .map((e) => (e as { textDelta: string }).textDelta)
    .join("");
}

describe("HFT vision-language loading", () => {
  it("loads processor + AutoModelForImageTextToText with the pipeline's options, and caches them", async () => {
    pipelines.delete(cacheKey);
    const processor = Object.assign(async () => ({}), {
      image_processor: {},
      tokenizer: { all_special_ids: [] },
    });
    const model = { dispose: vi.fn(async () => {}) };
    const loadProcessor = vi
      .spyOn(sdk.AutoProcessor, "from_pretrained")
      .mockResolvedValue(processor as never);
    const loadModel = vi
      .spyOn(sdk.AutoModelForImageTextToText, "from_pretrained")
      .mockResolvedValue(model as never);

    const loaded = await getPipeline(vlmModel, () => {});

    expect(loaded).toEqual({
      task: "image-text-to-text",
      processor,
      tokenizer: processor.tokenizer,
      model,
    });
    expect(loadProcessor).toHaveBeenCalledWith(
      "test-org/qwen-vl-fake",
      expect.objectContaining({ revision: "v1" })
    );
    expect(loadModel).toHaveBeenCalledWith(
      "test-org/qwen-vl-fake",
      expect.objectContaining({ revision: "v1", dtype: "q4", device: "webgpu" })
    );
    expect(pipelines.get(cacheKey)).toBe(loaded);

    // A second caller gets the cached entry, and eviction releases the model.
    expect(await getPipeline(vlmModel, () => {})).toBe(loaded);
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(await removeCachedPipeline(cacheKey)).toBe(true);
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports an incomplete cache as a retryable null-processor failure and releases the model", async () => {
    pipelines.delete(cacheKey);
    const model = { dispose: vi.fn(async () => {}) };
    vi.spyOn(sdk.AutoProcessor, "from_pretrained").mockResolvedValue({
      image_processor: undefined,
      tokenizer: {},
    } as never);
    vi.spyOn(sdk.AutoModelForImageTextToText, "from_pretrained").mockResolvedValue(model as never);

    await expect(getPipeline(vlmModel, () => {})).rejects.toThrow(HFT_NULL_PROCESSOR_PREFIX);
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(pipelines.has(cacheKey)).toBe(false);
  });

  it("releases the model when the processor fails to load", async () => {
    pipelines.delete(cacheKey);
    const model = { dispose: vi.fn(async () => {}) };
    vi.spyOn(sdk.AutoProcessor, "from_pretrained").mockRejectedValue(new Error("no processor"));
    vi.spyOn(sdk.AutoModelForImageTextToText, "from_pretrained").mockResolvedValue(model as never);

    await expect(getPipeline(vlmModel, () => {})).rejects.toThrow("no processor");
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("buildHftVisionMessages", () => {
  it("keeps a user image in place and moves a tool's image to a user turn after the results", () => {
    const { messages, images } = buildHftVisionMessages(imageHistory(), "Be brief.", "", "auto");
    expect(messages).toEqual([
      { role: "system", content: [{ type: "text", text: "Be brief." }] },
      {
        role: "user",
        content: [{ type: "text", text: "What city is this, and its weather?" }, { type: "image" }],
      },
      {
        role: "assistant",
        content: [],
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: { city: "Paris" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "text",
            text: "18C and cloudy, chart attached.\n[image 1] follows in the next message",
          },
        ],
        tool_call_id: "call_1",
        name: "get_weather",
      },
      {
        role: "user",
        content: [
          { type: "text", text: HFT_TOOL_IMAGES_INTRO },
          { type: "text", text: "\n[image 1]\n" },
          { type: "image" },
        ],
      },
    ]);
    // In placeholder order: the user's photo first, then the tool's chart.
    expect(images).toEqual([PHOTO, CHART]);
  });

  it("waits for every result of a turn before the images, numbering them in order", () => {
    const history: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "Compare them." }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "get_weather", input: {} },
          { type: "tool_use", id: "b", name: "get_weather", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "a", content: [CHART], is_error: undefined },
          { type: "tool_result", tool_use_id: "b", content: [SCAN], is_error: undefined },
        ],
      },
    ];
    const { messages, images } = buildHftVisionMessages(history, undefined, "", undefined);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(messages[3]!.content).toEqual([
      { type: "text", text: "[image 2] follows in the next message" },
    ]);
    expect(messages[4]!.content).toEqual([
      { type: "text", text: HFT_TOOL_IMAGES_INTRO },
      { type: "text", text: "\n[image 1]\n" },
      { type: "image" },
      { type: "text", text: "\n[image 2]\n" },
      { type: "image" },
    ]);
    expect(images).toEqual([CHART, SCAN]);
  });

  it("folds a required tool choice into the one system message", () => {
    const { messages } = buildHftVisionMessages(undefined, "Be brief.", "Hi", "required");
    expect(messages).toEqual([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "Be brief.\n\nYou MUST call one of the provided tools in this turn.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  it("takes images from a block prompt when there is no history", () => {
    const { messages, images } = buildHftVisionMessages(
      undefined,
      undefined,
      ["Describe", PHOTO],
      undefined
    );
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Describe" }, { type: "image" }] },
    ]);
    expect(images).toEqual([PHOTO]);
  });

  it("a text model still names a tool's image instead of sending it", () => {
    const messages = buildHFTMessages(imageHistory(), undefined, "", undefined);
    const tool = messages.find((m) => m.role === "tool")!;
    expect(tool.content).toBe(
      "18C and cloudy, chart attached.\n[image/jpeg image returned; this model reads text only]"
    );
    expect(JSON.stringify(messages)).not.toContain(CHART.data);
  });
});

describe("HFT_ToolCalling on a vision-language model", () => {
  it("hands the processor every image, user's first, beside a prompt holding a placeholder for each", async () => {
    fake.reply(["It is Paris."]);
    await runToolCalling({ messages: imageHistory() });

    expect(fake.processorCalls).toHaveLength(1);
    const call = fake.processorCalls[0]!;
    // A text-first processor (Qwen-VL, Idefics3): prompt, then images.
    expect(typeof call.args[0]).toBe("string");
    expect(call.images.map((i) => i.base64)).toEqual([PHOTO.data, CHART.data]);
    expect(call.images.map((i) => i.mimeType)).toEqual([PHOTO.mimeType, CHART.mimeType]);
    expect(call.args[2]).toEqual({ add_special_tokens: false });
    expect(call.prompt.split("<image>")).toHaveLength(3);
    // No image travels as text.
    expect(call.prompt).not.toContain(PHOTO.data);
    expect(call.prompt).not.toContain(CHART.data);
    // The rendered order: the user's photo, the tool result, then the chart.
    const order = ["<image>", "[image 1] follows", "[image 1]\n<image>"].map((s) =>
      call.prompt.indexOf(s)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(fake.rendered[0]!.options).toMatchObject({
      add_generation_prompt: true,
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });
  });

  it("passes the images first to a processor that takes them first (LFM2-VL)", async () => {
    fake = fakeVisionModel(sdk.Lfm2VlProcessor);
    pipelines.set(cacheKey, fake.vlm as never);
    fake.reply(["Paris."]);
    await runToolCalling({ messages: imageHistory() });

    const call = fake.processorCalls[0]!;
    expect(Array.isArray(call.args[0])).toBe(true);
    expect(typeof call.args[1]).toBe("string");
    expect(call.images.map((i) => i.base64)).toEqual([PHOTO.data, CHART.data]);
  });

  it("tokenizes a turn without images, the processor untouched", async () => {
    fake.reply(["Hello."]);
    const { output } = await runToolCalling({ prompt: "Say hello." });
    expect(fake.processorCalls).toHaveLength(0);
    expect(fake.tokenizerCalls).toHaveLength(1);
    expect(fake.tokenizerCalls[0]!.options).toEqual({ add_special_tokens: false });
    expect(output.text).toBe("Hello.");
  });

  it("routes thinking to reasoning, strips call markup from text, and parses the call", async () => {
    fake.reply([
      "<think>The photo shows the Eiffel Tower.</think>",
      "Checking the weather.",
      '<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>',
    ]);
    const { events, output } = await runToolCalling({
      messages: [{ role: "user", content: [{ type: "text", text: "Where?" }, PHOTO] }],
    });
    expect(textOn(events as never, "reasoning")).toBe("The photo shows the Eiffel Tower.");
    expect(output.text).toBe("Checking the weather.");
    expect(output.toolCalls).toEqual([
      expect.objectContaining({ name: "get_weather", input: { city: "Paris" } }),
    ]);
    const finish = events.find((e) => e.type === "finish") as { data: ToolCallingTaskOutput };
    expect(finish.data).toEqual({ text: "", toolCalls: [] });
  });

  it("reports prefill and usage, and samples as a text model does", async () => {
    fake.reply(["a", "b"]);
    const { events } = await runToolCalling({ prompt: "Hi", temperature: 0.7, maxTokens: 12 });
    expect(events.some((e) => e.type === "phase" && e.message === "Prefilling")).toBe(true);
    const usage = events.filter((e) => e.type === "usage").at(-1) as { usage: { input: number } };
    expect(usage.usage).toMatchObject({ input: 3, output: 2 });
    expect(fake.generated[0]).toMatchObject({
      max_new_tokens: 12,
      do_sample: true,
      temperature: 0.7,
    });
  });

  it("renders a checkpoint's prefix in full and keeps no KV session", async () => {
    fake.reply(["ok"]);
    await runToolCalling(
      { messages: [{ role: "user", content: [{ type: "text", text: "And now?" }] }] },
      {
        sessionId: "ckpt-parent",
        emitCheckpointId: "ckpt-child",
        prefix: {
          systemPrompt: "You read photos.",
          messages: [{ role: "user", content: [{ type: "text", text: "Remember this." }, SCAN] }],
          tools: [weatherTool],
        },
      }
    );
    const call = fake.processorCalls[0]!;
    expect(call.prompt).toContain("You read photos.");
    expect(call.prompt.indexOf("Remember this.")).toBeLessThan(call.prompt.indexOf("And now?"));
    expect(call.images.map((i) => i.base64)).toEqual([SCAN.data]);
    expect(fake.generated[0]!.past_key_values).toBeUndefined();
    expect(getHftSession("ckpt-child")).toBeUndefined();
    expect(getHftSession("ckpt-parent")).toBeUndefined();
  });
});

describe("HFT_Chat and HFT_TextGeneration on a vision-language model", () => {
  it("chat sends the conversation's images and streams the reply", async () => {
    fake.reply(["A ", "cat."]);
    const events: StreamEvent<never>[] = [];
    await HFT_Chat(
      {
        model: vlmModel,
        prompt: "",
        systemPrompt: "Describe images.",
        messages: [{ role: "user", content: [{ type: "text", text: "What is it?" }, PHOTO] }],
      } as unknown as AiChatProviderInput,
      vlmModel,
      new AbortController().signal,
      (event) => events.push(event as never),
      undefined,
      { sessionId: "chat-1" }
    );
    expect(fake.processorCalls[0]!.images.map((i) => i.base64)).toEqual([PHOTO.data]);
    expect(fake.processorCalls[0]!.prompt).toContain("Describe images.");
    expect(textOn(events, "text")).toBe("A cat.");
    expect(getHftSession("chat-1")).toBeUndefined();
  });

  it("text generation renders the prompt as a user turn and decodes greedily by default", async () => {
    fake.reply(["Done."]);
    const events: StreamEvent<never>[] = [];
    await HFT_TextGeneration(
      { model: vlmModel, prompt: "Write a haiku." } as unknown as TextGenerationTaskInput,
      vlmModel,
      new AbortController().signal,
      (event) => events.push(event as never)
    );
    expect(fake.rendered[0]!.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Write a haiku." }] },
    ]);
    expect(fake.generated[0]).toMatchObject({ do_sample: false, max_new_tokens: 4096 });
    expect(textOn(events, "text")).toBe("Done.");
  });

  it("a cache checkpoint on a vision-language model warms nothing and still names its handle", async () => {
    const events: StreamEvent<never>[] = [];
    await HFT_CacheCheckpoint(
      {} as never,
      vlmModel,
      new AbortController().signal,
      (event) => events.push(event as never),
      undefined,
      { sessionId: "ckpt-1", prefix: { systemPrompt: "x" } }
    );
    expect(events).toEqual([{ type: "finish", data: { checkpoint: "ckpt-1" } }]);
    expect(fake.generated).toHaveLength(0);
    expect(getHftSession("ckpt-1")).toBeUndefined();
  });

  it("refuses structured generation by name rather than calling a pipeline it does not have", async () => {
    await expect(
      HFT_StructuredGeneration(
        { prompt: "x", outputSchema: { type: "object" } } as never,
        vlmModel,
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow(/image-text-to-text/);
  });
});

describe("inferHftCapabilities for vision-language models", () => {
  const record = (model_id: string, provider_config: Record<string, unknown>) =>
    ({ model_id, provider_config, capabilities: [] }) as never;

  it("a vision-language load declares vision input and only what its run-fns serve", () => {
    const caps = inferHftCapabilities(
      record("onnx-community/LFM2.5-VL-450M-ONNX", { pipeline: "image-text-to-text" })
    );
    expect(caps).toEqual(
      expect.arrayContaining(["text.generation", "tool-use", "vision-input", "model.count-tokens"])
    );
    for (const missing of [
      "json-mode",
      "text.rewriter",
      "text.summary",
      "cache.checkpoint",
      "session.dispose",
    ]) {
      expect(caps).not.toContain(missing);
    }
  });

  it("names a vision-language model only while nothing set the load path", () => {
    expect(inferHftCapabilities(record("HuggingFaceTB/SmolVLM-256M-Instruct", {}))).toContain(
      "vision-input"
    );
    expect(
      inferHftCapabilities(
        record("onnx-community/Qwen2-VL-2B-Instruct", { pipeline: "text-generation" })
      )
    ).not.toContain("vision-input");
    expect(inferHftCapabilities(record("Xenova/blip-image-captioning-base", {}))).toContain(
      "image.to-text"
    );
  });
});
