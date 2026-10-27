/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiSessionContext,
  CheckpointPrefix,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolDefinition,
} from "@workglow/ai";
import { accumulatingEmit } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { expectNoFinishAccumulation } from "@workglow/test-contract/ai-provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConstrainedToolCall } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_ConstrainedToolCall";
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

describe("HFT_ToolCalling chat history", () => {
  it("hands earlier reasoning to the template when no tool has run yet", async () => {
    const pipeline = makeFakePipeline(["It is still sunny."]);
    const rendered: unknown[] = [];
    pipeline.tokenizer.apply_chat_template = (messages: unknown) => {
      rendered.push(messages);
      return RENDERED_PROMPT;
    };
    pipelines.set(cacheKey, pipeline);

    await HFT_ToolCalling(
      {
        ...input,
        messages: [
          { role: "user", content: [{ type: "text", text: "Weather?" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "No tool needed." },
              { type: "text", text: "Sunny." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "And now?" }] },
        ],
      } as unknown as ToolCallingTaskInput,
      model,
      new AbortController().signal,
      () => {}
    );

    expect(rendered[0]).toEqual([
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "Sunny.", reasoning_content: "No tool needed." },
      { role: "user", content: "And now?" },
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

const weatherTool = input.tools[0]!;
const timeTool: ToolDefinition = {
  name: "get_time",
  description: "Look up the time",
  inputSchema: {
    type: "object",
    properties: { zone: { type: "string" } },
    required: ["zone"],
  } as const,
};
const withChoice = (toolChoice: string, extra: object = {}): ToolCallingTaskInput =>
  ({ ...input, tools: [weatherTool, timeTool], toolChoice, ...extra }) as ToolCallingTaskInput;
const resolve = (
  forced: ToolCallingTaskInput,
  family: string | null = "qwen",
  texts: readonly string[] = [],
  prompt: string = RENDERED_PROMPT,
  prefix?: CheckpointPrefix
) => resolveConstrainedToolCall(forced, family, texts, prompt, prefix);

/**
 * Feeds `text` byte by byte through a grammar built over the one-byte-per-id
 * vocabulary and returns the index of the first byte it refused, or `undefined`
 * when the whole text was allowed and the grammar would now accept an end.
 */
async function firstRefusal(processor: any, text: string): Promise<number | "open" | undefined> {
  const { Tensor } = await loadTransformersSDK();
  const ids: bigint[] = [1n, 2n, 3n];
  for (let i = 0; i <= text.length; i++) {
    const logits = new Tensor("float32", new Float32Array(256), [1, 256]);
    processor([ids], logits);
    if (i === text.length) return logits.data[0] > -1e30 ? undefined : "open";
    const byte = text.charCodeAt(i);
    if (!(logits.data[byte] > -1e30)) return i;
    ids.push(BigInt(byte));
  }
  return undefined;
}

describe("resolveConstrainedToolCall", () => {
  it("leaves an auto turn to the model", () => {
    expect(resolve(withChoice("auto"))).toBe(undefined);
  });

  it("pins a named tool by name and arguments", () => {
    const c = resolve(withChoice("get_time"))!;
    expect(c.prefix).toBe("<tool_call>\n");
    expect(c.schema).toMatchObject({
      properties: { name: { const: "get_time" }, arguments: timeTool.inputSchema },
      required: ["name", "arguments"],
    });
  });

  it("names every tool when one call is required, and gives each its own arguments", () => {
    const c = resolve(withChoice("required"))!;
    expect(c.schema).toMatchObject({
      properties: { name: { enum: ["get_weather", "get_time"] } },
      allOf: [{ then: expect.anything() }, { then: expect.anything() }],
    });
    // Not a root `oneOf`: the engine checks that only once the object closes.
    expect(c.schema).not.toHaveProperty("oneOf");
  });

  it("declines where the grammar would be wrong", () => {
    const forced = withChoice("get_time");
    expect(resolve(forced, "llama")).toBe(undefined);
    expect(resolve(forced, null)).toBe(undefined);
    expect(resolve(forced, "qwen", ["qwen3.5-4b"])).toBe(undefined);
    expect(resolve(forced, "qwen", [], "<assistant><think>")).toBe(undefined);
    const afterTool = withChoice("get_time", {
      messages: [{ role: "tool", content: [] }],
    });
    expect(resolve(afterTool)).toBe(undefined);
  });

  it("reads a checkpoint's history and tools, which the call itself does not carry", () => {
    const toolsInPrefix: CheckpointPrefix = {
      tools: [weatherTool, timeTool],
      messages: [{ role: "tool", content: [] }],
    };
    const bare = withChoice("get_time", { tools: [] });
    // The tool result is in the prefix, so this turn may be the answer.
    expect(resolve(bare, "qwen", [], RENDERED_PROMPT, toolsInPrefix)).toBe(undefined);
    // Without it, the tool being asked for is found in the prefix's list.
    const c = resolve(bare, "qwen", [], RENDERED_PROMPT, { tools: [weatherTool, timeTool] })!;
    expect(c.schema).toMatchObject({ properties: { name: { const: "get_time" } } });
    const required = resolve(withChoice("required", { tools: [] }), "qwen", [], RENDERED_PROMPT, {
      tools: [weatherTool, timeTool],
    })!;
    expect(required.schema).toMatchObject({
      properties: { name: { enum: ["get_weather", "get_time"] } },
    });
  });

  it("hands the engine the same schema object for the same tools", () => {
    // The engine caches the masks it computes on the schema object, and a turn
    // arrives as a fresh copy of the tools, so the object is found by content.
    const copy = (): ToolCallingTaskInput => structuredClone(withChoice("get_time"));
    expect(resolve(copy())!.schema).toBe(resolve(copy())!.schema);
    expect(resolve(withChoice("required"))!.schema).toBe(resolve(withChoice("required"))!.schema);
  });

  it("leaves out annotations the engine refuses and re-roots a tool's own references", () => {
    const tool = {
      name: "walk",
      description: "Walk a tree",
      inputSchema: {
        type: "object",
        "x-ui-order": ["node"],
        properties: {
          node: { $ref: "#/$defs/Node", "x-ui-manual": true },
          "x-api-key": { type: "string" },
          tag: { const: { $ref: "#/not/a/schema" } },
        },
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#" } },
            additionalProperties: false,
          },
        },
      },
    };
    const c = resolve(withChoice("walk", { tools: [tool] }))!;
    const args = (c.schema as any).properties.arguments;
    expect(args["x-ui-order"]).toBe(undefined);
    expect(args.properties.node["x-ui-manual"]).toBe(undefined);
    expect(args.properties["x-api-key"]).toEqual({ type: "string" });
    expect(args.properties.tag).toEqual({ const: { $ref: "#/not/a/schema" } });
    expect(args.properties.node.$ref).toBe("#/properties/arguments/$defs/Node");
    expect(args.$defs.Node.properties.next.$ref).toBe("#/properties/arguments");

    const many = resolve(withChoice("required", { tools: [tool, timeTool] }))!;
    expect((many.schema as any).$defs.arguments0.properties.node.$ref).toBe(
      "#/$defs/arguments0/$defs/Node"
    );
  });
});

describe("HFT_ToolCalling constrained decoding", () => {
  async function runForced(
    toolChoice: string,
    pieces: readonly string[],
    extra: object = {},
    context?: AiSessionContext
  ): Promise<{ events: StreamEvent<never>[]; output: ToolCallingTaskOutput; opts: any[] }> {
    const opts: any[] = [];
    const pipeline = makeFakePipeline(pieces);
    // One byte per id: the direct vocab form StructuredOutputProcessor accepts.
    pipeline.tokenizer.tokens = Array.from({ length: 256 }, (_, id) => Uint8Array.of(id));
    pipeline.tokenizer.eos_token_id = 0;
    const inner = pipeline;
    const wrapped: any = async (prompt: string, o: Record<string, unknown>) => {
      opts.push({ prompt, ...o });
      return inner(prompt, o);
    };
    wrapped.tokenizer = pipeline.tokenizer;
    wrapped.model = pipeline.model;
    pipelines.set(cacheKey, wrapped);
    const events: StreamEvent<never>[] = [];
    const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
    await HFT_ToolCalling(
      withChoice(toolChoice, extra),
      model,
      new AbortController().signal,
      (event) => {
        events.push(event as StreamEvent<never>);
        accumulator.emit(event);
      },
      undefined,
      context
    );
    return { events, output: accumulator.result(), opts };
  }

  it("opens the tag, constrains the body, and parses the unclosed call", async () => {
    const { output, opts, events } = await runForced("get_time", [
      '{"name": "get_time", ',
      '"arguments": {"zone": "UTC"}}',
    ]);
    expect(opts[0].prompt.endsWith("<tool_call>\n")).toBe(true);
    expect(opts[0].logits_processor?.constructor.name).toBe("StructuredOutputProcessor");
    expect(output.toolCalls).toEqual([
      expect.objectContaining({ name: "get_time", input: { zone: "UTC" } }),
    ]);
    // The body is the call, not something the assistant said.
    expect(events.some((e: any) => e.port === "text")).toBe(false);
  });

  it("keeps a call to a tool only the checkpoint prefix holds", async () => {
    const { output } = await runForced(
      "get_time",
      ['{"name": "get_time", "arguments": {"zone": "UTC"}}'],
      { tools: [] },
      { sessionId: "cp", prefix: { tools: [timeTool] } } as AiSessionContext
    );
    expect(output.toolCalls).toEqual([
      expect.objectContaining({ name: "get_time", input: { zone: "UTC" } }),
    ]);
  });

  it("does not constrain an auto turn", async () => {
    const { opts } = await runForced("auto", [TOOL_PIECES.join("")]);
    expect(opts[0].logits_processor).toBe(undefined);
    expect(opts[0].prompt.endsWith("<tool_call>\n")).toBe(false);
  });

  it("does not let a call name a tool that is not on offer", async () => {
    // A grammar keeps the state of the one text fed through it, so each case gets its own.
    const grammar = async (): Promise<unknown> =>
      (await runForced("required", ['{"name": "get_time", "arguments": {}}'])).opts[0]
        .logits_processor;

    expect(
      await firstRefusal(await grammar(), '{"name":"get_time","arguments":{"zone":"UTC"}}')
    ).toBe(undefined);
    // Refused at the byte that makes the name nobody's, not at the closing brace
    // after a whole call has been written.
    expect(await firstRefusal(await grammar(), '{"name":"get_foo","arguments":{}}')).toBe(13);
    // A call without its arguments cannot end.
    expect(await firstRefusal(await grammar(), '{"name":"get_time"}')).toBe(18);
  });

  it("falls back to free decoding when the engine rejects a tool schema", async () => {
    const bad = withChoice("get_time", {
      tools: [
        {
          ...timeTool,
          inputSchema: { type: "object", properties: { zone: { type: "string", pattern: "^a$" } } },
        },
      ],
    });
    const pipeline = makeFakePipeline(TOOL_PIECES);
    pipeline.tokenizer.tokens = Array.from({ length: 256 }, (_, id) => Uint8Array.of(id));
    pipeline.tokenizer.eos_token_id = 0;
    pipelines.set(cacheKey, pipeline);
    const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
    await HFT_ToolCalling(
      bad,
      model,
      new AbortController().signal,
      accumulator.emit,
      undefined,
      undefined
    );
    expect(accumulator.result().text).toContain("Let me check");
  });

  it("decodes again without the grammar when the grammar fails mid-generation", async () => {
    const pipeline = makeFakePipeline(TOOL_PIECES);
    pipeline.tokenizer.tokens = Array.from({ length: 256 }, (_, id) => Uint8Array.of(id));
    pipeline.tokenizer.eos_token_id = 0;
    const attempts: any[] = [];
    const wrapped: any = async (prompt: string, o: Record<string, unknown>) => {
      attempts.push({ prompt, ...o });
      if (o.logits_processor) {
        // What the engine does at a dead end, after the streamer saw some text.
        (o.streamer as any).callback_function('{"name": "get_t');
        throw new Error("The constraint reached a dead end before producing a valid output.");
      }
      return pipeline(prompt, o);
    };
    wrapped.tokenizer = pipeline.tokenizer;
    wrapped.model = pipeline.model;
    pipelines.set(cacheKey, wrapped);

    const events: StreamEvent<never>[] = [];
    const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
    await HFT_ToolCalling(
      withChoice("get_weather"),
      model,
      new AbortController().signal,
      (event) => {
        events.push(event as StreamEvent<never>);
        accumulator.emit(event);
      },
      undefined,
      undefined
    );

    expect(attempts.map((a) => !!a.logits_processor)).toEqual([true, false]);
    expect(attempts[1].prompt.endsWith("<tool_call>\n")).toBe(false);
    // Nothing of the failed attempt leaked into the answer.
    expect(accumulator.result().text).toBe(PREAMBLE);
    expect(accumulator.result().toolCalls).toEqual([
      expect.objectContaining({ name: "get_weather", input: { city: "Paris" } }),
    ]);
  });

  it("keeps usage counting up across the retry", async () => {
    const pipeline = makeFakePipeline(TOOL_PIECES);
    pipeline.tokenizer.tokens = Array.from({ length: 256 }, (_, id) => Uint8Array.of(id));
    pipeline.tokenizer.eos_token_id = 0;
    const wrapped: any = async (prompt: string, o: Record<string, unknown>) => {
      const streamer = o.streamer as any;
      // The prompt (3 tokens) reaches the model, then some output is made.
      streamer.put([[1n, 2n, 3n]]);
      if (o.logits_processor) {
        streamer.token_callback_function([1n, 2n]);
        throw new Error("The constraint reached a dead end before producing a valid output.");
      }
      streamer.token_callback_function([1n, 2n, 3n, 4n]);
      const done = await pipeline(prompt, o);
      streamer.end();
      return done;
    };
    wrapped.tokenizer = pipeline.tokenizer;
    wrapped.model = pipeline.model;
    pipelines.set(cacheKey, wrapped);

    const usages: Array<{ input?: number; output?: number }> = [];
    await HFT_ToolCalling(
      withChoice("get_weather"),
      model,
      new AbortController().signal,
      (event: any) => {
        if (event.type === "usage") usages.push(event.usage);
      },
      undefined,
      undefined
    );

    for (let i = 1; i < usages.length; i++) {
      expect(usages[i]!.input!).toBeGreaterThanOrEqual(usages[i - 1]!.input!);
      expect(usages[i]!.output!).toBeGreaterThanOrEqual(usages[i - 1]!.output!);
    }
    const last = usages.at(-1)!;
    // The prompt was read by both attempts, and the failed one made tokens too.
    expect(last.input).toBe(6);
    expect(last.output).toBe(6);
  });

  it("does not hide a failure that is not the grammar's", async () => {
    const pipeline = makeFakePipeline(TOOL_PIECES);
    pipeline.tokenizer.tokens = Array.from({ length: 256 }, (_, id) => Uint8Array.of(id));
    pipeline.tokenizer.eos_token_id = 0;
    const wrapped: any = async () => {
      throw new Error("out of memory");
    };
    wrapped.tokenizer = pipeline.tokenizer;
    wrapped.model = pipeline.model;
    pipelines.set(cacheKey, wrapped);
    await expect(
      HFT_ToolCalling(
        withChoice("auto"),
        model,
        new AbortController().signal,
        () => {},
        undefined,
        undefined
      )
    ).rejects.toThrow("out of memory");
  });
});
