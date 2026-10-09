/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiSessionContext, ToolCallingTaskInput, ToolCallingTaskOutput } from "@workglow/ai";
import { accumulatingEmit } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { expectNoFinishAccumulation } from "@workglow/test-contract/ai-provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearPipelineCache,
  getPipelineCacheKey,
  loadTransformersSDK,
  pipelines,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";
import {
  buildHFTMessages,
  createHftDeltaRouter,
  HFT_ToolCalling,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_ToolCalling";

// "qwen" in the path selects the Hermes-style `<tool_call>` parser family.
const model = {
  model_id: "hft-test-qwen",
  provider: "HF_TRANSFORMERS_ONNX",
  provider_config: { model_path: "test-org/qwen-fake", pipeline: "text-generation" },
} as never;
const cacheKey = getPipelineCacheKey(model);

const PREAMBLE = "Let me check the weather.";
/**
 * What the fake model decodes, in the pieces the streamer hands them over.
 * The open tag is split across pieces so the markup filter has to hold a
 * partial tag back rather than leak it onto the text port.
 */
const TOOL_PIECES: readonly string[] = [
  "Let me check ",
  "the weather.<tool",
  '_call>{"name": "get_weather", ',
  '"arguments": {"city": "Paris"}}</tool_call>',
];

const RENDERED_PROMPT = "<user>What is the weather?</user>\n<assistant>";

function makeFakePipeline(
  pieces: readonly string[] = TOOL_PIECES,
  rendered: string = RENDERED_PROMPT
): any {
  const tokenizer = Object.assign((text: string) => ({ input_ids: { dims: [1, text.length] } }), {
    all_special_ids: [] as number[],
    apply_chat_template: () => rendered,
    decode: () => "",
  });
  const hfModel = {
    generate: async (args: Record<string, any>) => {
      for (const piece of pieces) args.streamer?.callback_function?.(piece);
      return { dims: [1, args.input_ids.dims[1]] };
    },
  };
  const pipeline: any = async (prompt: string, opts: Record<string, unknown>) => {
    await hfModel.generate({ ...tokenizer(prompt), ...opts });
    return [{ generated_text: "" }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = hfModel;
  return pipeline;
}

const input = {
  model,
  prompt: "What is the weather in Paris?",
  tools: [
    {
      name: "get_weather",
      description: "Look up the weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  toolChoice: "auto",
} as unknown as ToolCallingTaskInput;

async function run(sessionContext: AiSessionContext | undefined): Promise<{
  readonly events: StreamEvent<never>[];
  readonly output: ToolCallingTaskOutput;
}> {
  const events: StreamEvent<never>[] = [];
  const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
  await HFT_ToolCalling(
    input,
    model,
    new AbortController().signal,
    (event) => {
      events.push(event as StreamEvent<never>);
      accumulator.emit(event);
    },
    undefined,
    sessionContext
  );
  return { events, output: accumulator.result() };
}

beforeAll(async () => {
  await loadTransformersSDK();
});

beforeEach(async () => {
  await clearPipelineCache();
  pipelines.set(cacheKey, makeFakePipeline());
});

afterEach(async () => {
  await clearPipelineCache();
});

describe("HFT_ToolCalling stream output", () => {
  it.each([
    ["without a session", undefined],
    ["with a fingerprint session", { sessionId: "hft-tool-fp" }],
  ] as const)("streams text and a tool call %s, and finish carries neither", async (_, ctx) => {
    const { events, output } = await run(ctx);

    expectNoFinishAccumulation(events);

    // The stream alone carries the answer: the markup is filtered off the text
    // port and the parsed call arrives as an object-delta.
    const text = events
      .filter((e) => e.type === "text-delta" && e.port === "text")
      .map((e) => (e as { textDelta: string }).textDelta)
      .join("");
    expect(text).toBe(PREAMBLE);
    expect(events.some((e) => e.type === "object-delta" && e.port === "toolCalls")).toBe(true);

    expect(output.text).toBe(PREAMBLE);
    expect(output.toolCalls).toEqual([
      { id: expect.any(String), name: "get_weather", input: { city: "Paris" } },
    ]);
  });
});

function portText(events: StreamEvent<never>[], port: string): string {
  return events
    .filter((e) => e.type === "text-delta" && e.port === port)
    .map((e) => (e as { textDelta: string }).textDelta)
    .join("");
}

describe("HFT_ToolCalling thinking", () => {
  it("routes a <think> block to the reasoning port and keeps it out of the answer", async () => {
    pipelines.set(
      cacheKey,
      makeFakePipeline(["<thi", "nk>I should check", " the map.</th", "ink>It is sunny."])
    );
    const { events, output } = await run(undefined);

    expect(portText(events, "reasoning")).toBe("I should check the map.");
    expect(portText(events, "text")).toBe("It is sunny.");
    expect(output.text).toBe("It is sunny.");
    expect(output.toolCalls).toEqual([]);
    expectNoFinishAccumulation(events);
  });

  it("treats generation as already inside <think> when the prompt opens the tag", async () => {
    pipelines.set(
      cacheKey,
      makeFakePipeline(["planning</think>\n\nDone."], "<assistant>\n<think>\n")
    );
    const { events } = await run(undefined);

    expect(portText(events, "reasoning")).toBe("planning");
    expect(portText(events, "text")).toBe("\n\nDone.");
  });

  it("parses the tool call after the thinking, and ignores one quoted inside it", async () => {
    pipelines.set(
      cacheKey,
      makeFakePipeline([
        '<think>Maybe <tool_call>{"name": "get_weather", "arguments": {"city": "Rome"}}</tool_call>?',
        "</think>",
        '<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>',
      ])
    );
    const { events, output } = await run(undefined);

    expect(portText(events, "text")).toBe("");
    expect(output.toolCalls).toEqual([
      { id: expect.any(String), name: "get_weather", input: { city: "Paris" } },
    ]);
  });
});

describe("createHftDeltaRouter", () => {
  it("sends <think> content to reasoning and the answer to text", () => {
    const seen: Array<{ port: string; textDelta: string }> = [];
    const router = createHftDeltaRouter((e) => seen.push(e), false);
    router.feed("<think>a</think>b");
    router.flush();
    expect(seen).toEqual([
      { type: "text-delta", port: "reasoning", textDelta: "a" },
      { type: "text-delta", port: "text", textDelta: "b" },
    ]);
    expect(router.answerText()).toBe("b");
  });

  it("starts on reasoning when told the prompt opened the tag", () => {
    const seen: Array<{ port: string; textDelta: string }> = [];
    const router = createHftDeltaRouter((e) => seen.push(e), true);
    router.feed("a</think>b");
    router.flush();
    expect(seen.map((e) => [e.port, e.textDelta])).toEqual([
      ["reasoning", "a"],
      ["text", "b"],
    ]);
  });
});

describe("buildHFTMessages", () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Need the weather tool." },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "sunny" }],
        },
      ],
    },
  ] as never;

  it("replays reasoning as reasoning_content on the assistant turn", () => {
    const out = buildHFTMessages(history, undefined, undefined, undefined);
    expect(out[1]).toEqual({
      role: "assistant",
      content: "Checking.",
      reasoning_content: "Need the weather tool.",
      tool_calls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
    });
  });

  it("omits reasoning_content when the turn has no reasoning", () => {
    const out = buildHFTMessages(
      [{ role: "assistant", content: [{ type: "text", text: "Hi" }] }] as never,
      undefined,
      undefined,
      undefined
    );
    expect(out[0]).toEqual({ role: "assistant", content: "Hi" });
  });

  it("names a tool message after the tool_use it answers", () => {
    const out = buildHFTMessages(history, undefined, undefined, undefined);
    expect(out[2]).toEqual({
      role: "tool",
      content: "sunny",
      tool_call_id: "call_1",
      name: "get_weather",
    });
  });

  it("resolves a repeated id to the most recent tool_use", () => {
    const out = buildHFTMessages(
      [
        { role: "assistant", content: [{ type: "tool_use", id: "x", name: "first", input: {} }] },
        { role: "assistant", content: [{ type: "tool_use", id: "x", name: "second", input: {} }] },
        {
          role: "tool",
          content: [
            { type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "r" }] },
          ],
        },
      ] as never,
      undefined,
      undefined,
      undefined
    );
    expect(out[2]).toMatchObject({ role: "tool", name: "second" });
  });

  it("leaves the name off a result with no matching tool_use", () => {
    const out = buildHFTMessages(
      [
        {
          role: "tool",
          content: [
            { type: "tool_result", tool_use_id: "z", content: [{ type: "text", text: "r" }] },
          ],
        },
      ] as never,
      undefined,
      undefined,
      undefined
    );
    expect(out[0]).toEqual({ role: "tool", content: "r", tool_call_id: "z" });
  });
});
