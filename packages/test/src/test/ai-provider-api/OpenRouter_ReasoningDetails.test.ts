/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as openRouterTestOnly } from "@workglow/openrouter/ai";
import {
  createReasoningDetailAccumulator,
  encodeReasoningTurn,
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
  const detail = { type: "reasoning.text", text: "x", signature: "sig" };
  const written = (ids: string[]) => ids.map((id) => ({ id, name: "shot", arguments: "{}" }));
  const turn = (
    callIds: string[],
    payloadOf: unknown = { calls: written(callIds), details: [detail] }
  ): any => ({
    role: "assistant",
    content: [
      { type: "reasoning", text: "", provider: KEY, payload: JSON.stringify(payloadOf) },
      ...callIds.map((id) => ({ type: "tool_use", id, name: "shot", input: {} })),
    ],
  });
  const converted = (ids: string[]): any => ({
    role: "assistant",
    content: null,
    ...(ids.length > 0
      ? {
          tool_calls: ids.map((id) => ({
            id,
            type: "function",
            function: { name: "shot", arguments: "{}" },
          })),
        }
      : {}),
  });

  it("attaches the details to the turn whose call ids match, without mutating", () => {
    const input = [{ role: "user", content: "hi" }, converted(["a", "b"])];
    const out = withReasoningDetails(
      input,
      [{ role: "user", content: [{ type: "text", text: "hi" }] }, turn(["a", "b"])],
      KEY
    );
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toMatchObject({ reasoning_details: [detail] });
    expect(input[1]).not.toHaveProperty("reasoning_details");
  });

  it("matches a turn with no tool calls against an empty id list", () => {
    const out = withReasoningDetails([converted([])], [turn([])], KEY);
    expect(out[0]).toMatchObject({ reasoning_details: [detail] });
  });

  it("does not replay when an id changed, was dropped or was added", () => {
    const history = [turn(["a", "b"])];
    expect(withReasoningDetails([converted(["a", "z"])], history, KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
    expect(withReasoningDetails([converted(["a"])], history, KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
    expect(withReasoningDetails([converted(["a", "b", "c"])], history, KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
    expect(withReasoningDetails([converted(["b", "a"])], history, KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
  });

  it("does not replay when a kept id now carries another name or arguments", () => {
    const history = [turn(["a"])];
    const renamed = converted(["a"]);
    renamed.tool_calls[0].function.name = "other";
    expect(withReasoningDetails([renamed], history, KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
    const edited = converted(["a"]);
    edited.tool_calls[0].function.arguments = '{"x":1}';
    expect(withReasoningDetails([edited], history, KEY)[0]).not.toHaveProperty("reasoning_details");
  });

  it("does not replay a payload that is not a turn, or another model's", () => {
    expect(withReasoningDetails([converted([])], [turn([], [detail])], KEY)[0]).not.toHaveProperty(
      "reasoning_details"
    );
    expect(
      withReasoningDetails([converted([])], [turn([], "not json{")], KEY)[0]
    ).not.toHaveProperty("reasoning_details");
    expect(
      withReasoningDetails([converted([])], [turn([])], "openrouter:other/model")[0]
    ).not.toHaveProperty("reasoning_details");
  });

  it("does not replay details that are not typed objects", () => {
    for (const details of [[null], [7], [{ text: "untyped" }], [detail, null]]) {
      expect(
        withReasoningDetails([converted([])], [turn([], { calls: [], details })], KEY)[0]
      ).not.toHaveProperty("reasoning_details");
    }
  });
});

describe("encodeReasoningTurn", () => {
  it("carries the calls beside the details, arguments as the converter writes them", () => {
    expect(
      JSON.parse(encodeReasoningTurn([{ id: "c1", name: "shot", input: { a: 1 } }], details)!)
    ).toEqual({ calls: [{ id: "c1", name: "shot", arguments: '{"a":1}' }], details });
  });

  it("refuses an anthropic thinking block cut off before its signature", () => {
    const cut = [{ type: "reasoning.text", format: "anthropic-claude-v1", text: "hm" }];
    expect(encodeReasoningTurn([], cut)).toBeUndefined();
    expect(encodeReasoningTurn([], [{ ...cut[0], signature: "" }])).toBeUndefined();
    expect(encodeReasoningTurn([], [{ ...cut[0], signature: "sig" }])).toBeDefined();
  });

  it("keeps a signature-less text detail from another format", () => {
    const plain = [{ type: "reasoning.text", format: "unknown", text: "hm" }];
    expect(encodeReasoningTurn([], plain)).toBeDefined();
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
    (r: any) =>
      [...r.serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") ===
      "text.generation,tool-use"
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

  function replayInput(provider: string, callId = "c1", payloadCallId = callId): any {
    return {
      prompt: "look",
      tools,
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }] },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "",
              provider,
              payload: JSON.stringify({
                calls: [{ id: payloadCallId, name: "shot", arguments: "{}" }],
                details,
              }),
            },
            { type: "tool_use", id: callId, name: "shot", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", tool_use_id: callId, content: [{ type: "text", text: "ok" }] },
          ],
        },
      ],
    };
  }

  it("forwards thinking carried only in reasoning_details to the reasoning port, once", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([
        // A null entry is malformed and skipped, not a reason to fail the run.
        chunk({
          reasoning_details: [null, { type: "reasoning.text", index: 0, text: "only here" }],
        }),
        // An empty legacy field must not hide the details' text.
        chunk({
          reasoning_content: "",
          reasoning_details: [{ type: "reasoning.text", index: 0, text: ", and here" }],
        }),
        chunk({
          reasoning: "legacy",
          reasoning_details: [{ type: "reasoning.text", index: 0, text: "legacy" }],
        }),
        // Nor an empty alias hide the other one's text, with or without details.
        chunk({
          reasoning: " too",
          reasoning_content: "",
          reasoning_details: [{ type: "reasoning.text", index: 0, text: " too" }],
        }),
        chunk({ reasoning: "!", reasoning_content: "" }),
        chunk({ content: "done" }),
        chunk({}, "stop"),
      ])
    );
    const events: any[] = [];
    await findRunFn()(
      { prompt: "look", tools },
      modelConfig,
      new AbortController().signal,
      (e: any) => events.push(e)
    );
    const reasoning = events
      .filter((e) => e.type === "text-delta" && e.port === "reasoning")
      .map((e) => e.textDelta)
      .join("");
    expect(reasoning).toBe("only here, and herelegacy too!");
  });

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
      objectDelta: {
        provider: KEY,
        payload: JSON.stringify({ calls: [{ id: "c1", name: "shot", arguments: "{}" }], details }),
      },
    });
    expect(nativeIndex).toBeLessThan(events.findIndex((e) => e.type === "finish"));
  });

  it("emits an empty call list for a round that made no tool calls", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([
        chunk({ reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "xyz" }] }),
        chunk({ content: "done" }, "stop"),
      ])
    );
    const events: any[] = [];
    await findRunFn()(
      { prompt: "look", tools },
      modelConfig,
      new AbortController().signal,
      (e: any) => events.push(e)
    );
    const native = events.find((e) => e.port === "nativeTurn");
    expect(JSON.parse(native.objectDelta.payload)).toEqual({
      calls: [],
      details: [{ type: "reasoning.encrypted", index: 0, data: "xyz" }],
    });
  });

  it("emits no native turn when a call it made was filtered out", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([
        chunk({ reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "xyz" }] }),
        chunk({
          tool_calls: [
            { index: 0, id: "bad", type: "function", function: { name: "nope", arguments: "{}" } },
            { index: 1, id: "c2", type: "function", function: { name: "shot", arguments: "{}" } },
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
    expect(
      events.find((e) => e.type === "object-delta" && e.port === "toolCalls")?.objectDelta
    ).toEqual([expect.objectContaining({ id: "c2", name: "shot" })]);
    expect(events.some((e) => e.port === "nativeTurn")).toBe(false);
  });

  it("emits no native turn when thinking was cut off before its signature", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse([
        chunk({
          reasoning_details: [
            { type: "reasoning.text", index: 0, format: "anthropic-claude-v1", text: "hm" },
          ],
        }),
        chunk({ content: "partial" }, "length"),
      ])
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
});
