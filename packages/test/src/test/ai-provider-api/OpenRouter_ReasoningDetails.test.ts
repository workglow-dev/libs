/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as openRouterTestOnly } from "@workglow/openrouter/ai";
import {
  createReasoningDetailAccumulator,
  mergeReasoningDetailDelta,
  withReasoningDetails,
} from "../../../../../providers/openrouter/src/ai/common/OpenRouter_ReasoningDetails";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODEL = "anthropic/claude-sonnet-5-5";
const KEY = `openrouter:${MODEL}`;

describe("reasoning detail accumulator", () => {
  it("joins pieces by index and sorts the result", () => {
    const acc = createReasoningDetailAccumulator();
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.text", index: 0, text: "Let me " }]);
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.text", index: 0, text: "think." }]);
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.text", index: 0, signature: "sig" }]);
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.encrypted", index: 1, data: "xyz" }]);
    expect(acc.items()).toEqual([
      { type: "reasoning.text", index: 0, text: "Let me think.", signature: "sig" },
      { type: "reasoning.encrypted", index: 1, data: "xyz" },
    ]);
  });

  it("is undefined when nothing arrived", () => {
    expect(createReasoningDetailAccumulator().items()).toBeUndefined();
  });

  it("appends a piece with no index after the last one", () => {
    const acc = createReasoningDetailAccumulator();
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.summary", index: 0, summary: "a" }]);
    mergeReasoningDetailDelta(acc, [{ type: "reasoning.summary", summary: "b" }]);
    expect(acc.items()).toEqual([
      { type: "reasoning.summary", index: 0, summary: "a" },
      { type: "reasoning.summary", summary: "b" },
    ]);
  });

  it("ignores a delta that is not an array of objects", () => {
    const acc = createReasoningDetailAccumulator();
    mergeReasoningDetailDelta(acc, undefined);
    mergeReasoningDetailDelta(acc, "x");
    mergeReasoningDetailDelta(acc, [null, 3]);
    expect(acc.items()).toBeUndefined();
  });
});

describe("withReasoningDetails", () => {
  it("moves native_items to reasoning_details without mutating", () => {
    const input = [
      {
        role: "assistant",
        content: null,
        tool_calls: [],
        native_items: [{ type: "reasoning.text", text: "x" }],
      },
      { role: "user", content: "hi" },
    ];
    const out = withReasoningDetails(input);
    expect(out[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [],
      reasoning_details: [{ type: "reasoning.text", text: "x" }],
    });
    expect(out[0]).not.toHaveProperty("native_items");
    expect(out[1]).toEqual({ role: "user", content: "hi" });
    expect(input[0]).toHaveProperty("native_items");
  });
});

function sseResponse(chunks: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): unknown {
  return {
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const details = [
  { type: "reasoning.text", index: 0, text: "Let me think.", signature: "sig" },
  { type: "reasoning.encrypted", index: 1, data: "xyz" },
];

const tools = [{ name: "shot", description: "", inputSchema: { type: "object", properties: {} } }];

const modelConfig = {
  model_id: "openrouter-x",
  provider_config: { model_name: MODEL, api_key: "test-key" },
} as any;

function findRunFn() {
  const reg = openRouterTestOnly.OPENROUTER_RUN_FNS.find(
    (r: any) => [...r.serves].sort().join(",") === "text.generation,tool-use"
  );
  if (!reg) throw new Error("no OpenRouter tool-calling run-fn registered");
  return reg.runFn as any;
}

describe("OpenRouter tool calling replays reasoning_details", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function sentMessages(): any[] {
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string).messages;
  }

  function replayInput(provider: string): any {
    return {
      prompt: "look",
      tools,
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "", provider, payload: JSON.stringify(details) },
            { type: "tool_use", id: "c1", name: "shot", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok" }] },
          ],
        },
      ],
    };
  }

  it("emits the streamed details as the native turn before finish", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([
        chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "Let me " }] }),
        chunk({
          reasoning_details: [
            { type: "reasoning.text", index: 0, text: "think.", signature: "sig" },
            { type: "reasoning.encrypted", index: 1, data: "xyz" },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 0, id: "c1", type: "function", function: { name: "shot", arguments: "{}" } },
          ],
        }),
        chunk({}, "tool_calls"),
      ])
    );
    const events: any[] = [];
    await findRunFn()(
      { prompt: "look", tools },
      modelConfig,
      new AbortController().signal,
      (e: any) => events.push(e)
    );
    const nativeIndex = events.findIndex(
      (e) => e.type === "object-delta" && e.port === "nativeTurn"
    );
    expect(nativeIndex).toBeGreaterThan(-1);
    expect(events[nativeIndex]).toEqual({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: KEY, payload: JSON.stringify(details) },
    });
    expect(nativeIndex).toBeLessThan(events.findIndex((e) => e.type === "finish"));
  });

  it("emits no native turn when the stream carried no details", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([chunk({ content: "hi" }), chunk({}, "stop")])
    );
    const events: any[] = [];
    await findRunFn()(
      { prompt: "look", tools },
      modelConfig,
      new AbortController().signal,
      (e: any) => events.push(e)
    );
    expect(events.some((e) => e.port === "nativeTurn")).toBe(false);
  });

  it("sends the turn's own details back as reasoning_details", async () => {
    fetchSpy.mockImplementation(async () => sseResponse([]));
    await findRunFn()(replayInput(KEY), modelConfig, new AbortController().signal, () => {});
    const assistant = sentMessages().find((m) => m.role === "assistant");
    expect(assistant.reasoning_details).toEqual(details);
    expect(assistant).not.toHaveProperty("native_items");
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("does not replay details another model produced", async () => {
    fetchSpy.mockImplementation(async () => sseResponse([]));
    await findRunFn()(
      replayInput("openrouter:openai/gpt-6-luna"),
      modelConfig,
      new AbortController().signal,
      () => {}
    );
    const assistant = sentMessages().find((m) => m.role === "assistant");
    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant).not.toHaveProperty("native_items");
  });
});
