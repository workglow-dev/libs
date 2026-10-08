/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import {
  accumulateOpenAIResponsesStream,
  buildResponsesInput,
  buildResponsesTools,
  mapResponsesToolChoice,
  parseResponsesToolCalls,
  promptTextForResponsesUsageEstimate,
} from "@workglow/ai/provider-utils";
import type { StreamEvent } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

/** Turn a fixed array of Responses events into the async iterable the accumulator consumes. */
async function* events(list: readonly unknown[]): AsyncIterable<unknown> {
  for (const e of list) yield e;
}

/** Collect the accumulator's emitted stream events. */
async function collect(list: readonly unknown[]): Promise<any[]> {
  const out: any[] = [];
  await accumulateOpenAIResponsesStream(events(list), (e) => out.push(e));
  return out;
}

describe("accumulateOpenAIResponsesStream", () => {
  it("hands back every output item in order when asked for the native turn", async () => {
    const out: StreamEvent<Record<string, any>>[] = [];
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" };
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "c1",
      name: "look",
      arguments: "{}",
    };
    await accumulateOpenAIResponsesStream(
      events([
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.completed", response: { usage: undefined } },
      ]),
      (e) => out.push(e),
      { nativeTurnProvider: "openai" }
    );
    const native = out.find((e) => e.type === "object-delta" && e.port === "nativeTurn");
    expect(native).toEqual({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: "openai", payload: JSON.stringify([reasoning, call]) },
    });
  });

  it("emits no native turn unless asked", async () => {
    const out = await collect([
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r" } },
    ]);
    expect(out.some((e) => e.type === "object-delta" && e.port === "nativeTurn")).toBe(false);
  });

  it("maps output_text deltas to text-delta events on the text port", async () => {
    const out = await collect([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hel", item_id: "msg_1", output_index: 0 },
      { type: "response.output_text.delta", delta: "lo", item_id: "msg_1", output_index: 0 },
      { type: "response.output_text.delta", delta: "", item_id: "msg_1", output_index: 0 },
      { type: "response.completed" },
    ]);
    expect(out).toEqual([
      { type: "text-delta", port: "text", textDelta: "Hel" },
      { type: "text-delta", port: "text", textDelta: "lo" },
    ]);
  });

  it("accumulates a single tool call's fragmented argument JSON", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: '"Paris"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
      },
      { type: "response.completed" },
    ]);

    // Every emit targets the toolCalls port and carries the stable call_id.
    expect(out.every((e) => e.type === "object-delta" && e.port === "toolCalls")).toBe(true);
    expect(out.every((e) => e.objectDelta[0].id === "call_abc")).toBe(true);
    expect(out.every((e) => e.objectDelta[0].name === "get_weather")).toBe(true);

    // Final emit (from output_item.done) has the fully-parsed input.
    expect(out.at(-1)?.objectDelta[0].input).toEqual({ city: "Paris" });
  });

  it("keeps concurrent tool calls separate by output_index", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_a", name: "alpha", arguments: "" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "call_b", name: "beta", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_b",
        delta: '{"b":2}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_a",
        delta: '{"a":1}',
      },
      { type: "response.completed" },
    ]);

    const a = out.find((e) => e.objectDelta[0].id === "call_a");
    const b = out.find((e) => e.objectDelta[0].id === "call_b");
    expect(a.objectDelta[0]).toMatchObject({ name: "alpha", input: { a: 1 } });
    expect(b.objectDelta[0]).toMatchObject({ name: "beta", input: { b: 2 } });
  });

  it("interleaves text and tool-call deltas without cross-contamination", async () => {
    const out = await collect([
      { type: "response.output_text.delta", delta: "thinking...", output_index: 0, item_id: "msg" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "call_x", name: "fn", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_x",
        delta: "{}",
      },
      { type: "response.completed" },
    ]);
    expect(out[0]).toEqual({ type: "text-delta", port: "text", textDelta: "thinking..." });
    expect(out[1]).toMatchObject({ type: "object-delta", port: "toolCalls" });
  });

  it("synthesizes an id when a delta precedes output_item.added", async () => {
    const out = await collect([
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_orphan",
        delta: "{}",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].objectDelta[0].id).toBe("fc_orphan");
  });

  it("surfaces refusal deltas as first-class refusal events", async () => {
    const out = await collect([
      { type: "response.created" },
      { type: "response.refusal.delta", delta: "I can't ", item_id: "msg", output_index: 0 },
      { type: "response.refusal.delta", delta: "help with that.", item_id: "msg", output_index: 0 },
      { type: "response.completed" },
    ]);
    expect(out).toEqual([
      { type: "refusal", refusal: "I can't " },
      { type: "refusal", refusal: "help with that." },
    ]);
  });

  it("ignores reasoning-summary and lifecycle events", async () => {
    const out = await collect([
      { type: "response.created" },
      { type: "response.reasoning_summary_text.delta", delta: "hmm" },
      { type: "response.in_progress" },
      { type: "response.output_text.delta", delta: "hi", output_index: 0, item_id: "m" },
      { type: "response.completed" },
    ]);
    expect(out).toEqual([{ type: "text-delta", port: "text", textDelta: "hi" }]);
  });

  it("keeps concurrent tool calls separate by item id when output_index is absent", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "alpha",
          arguments: "",
        },
      },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "beta", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_a",
        delta: '{"a":1}',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_b",
        delta: '{"b":2}',
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "alpha",
          arguments: '{"a":1}',
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "beta",
          arguments: '{"b":2}',
        },
      },
      { type: "response.completed" },
    ]);

    const a = out.find((e) => e.objectDelta[0].id === "call_a");
    const b = out.find((e) => e.objectDelta[0].id === "call_b");
    expect(a.objectDelta[0]).toMatchObject({ name: "alpha", input: { a: 1 } });
    expect(b.objectDelta[0]).toMatchObject({ name: "beta", input: { b: 2 } });
  });

  it("falls back to output_index when neither item.id nor item_id is provided", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_a", name: "alpha", arguments: "" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "call_b", name: "beta", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"a":1}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"b":2}',
      },
      { type: "response.completed" },
    ]);

    const a = out.find((e) => e.objectDelta[0].id === "call_a");
    const b = out.find((e) => e.objectDelta[0].id === "call_b");
    expect(a.objectDelta[0]).toMatchObject({ name: "alpha", input: { a: 1 } });
    expect(b.objectDelta[0]).toMatchObject({ name: "beta", input: { b: 2 } });
  });

  it("prefers item id over a colliding output_index", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_x",
          call_id: "call_x",
          name: "alpha",
          arguments: "",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_y", call_id: "call_y", name: "beta", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_x",
        delta: '{"a":1}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_y",
        delta: '{"b":2}',
      },
      { type: "response.completed" },
    ]);

    const x = out.find((e) => e.objectDelta[0].id === "call_x");
    const y = out.find((e) => e.objectDelta[0].id === "call_y");
    expect(x.objectDelta[0]).toMatchObject({ name: "alpha", input: { a: 1 } });
    expect(y.objectDelta[0]).toMatchObject({ name: "beta", input: { b: 2 } });
  });
});

const TOOL: ToolDefinition = {
  name: "get_weather",
  description: "Get weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
} as unknown as ToolDefinition;

describe("buildResponsesTools", () => {
  it("emits the flat Responses function-tool shape", () => {
    const [tool] = buildResponsesTools([TOOL]);
    expect(tool.type).toBe("function");
    expect(tool.name).toBe("get_weather");
    expect(typeof tool.description).toBe("string");
    expect(tool.parameters).toEqual(TOOL.inputSchema);
    expect(tool.strict).toBe(false);
    // No nested `function` wrapper (that's the chat shape).
    expect((tool as any).function).toBeUndefined();
  });
});

describe("mapResponsesToolChoice", () => {
  it("passes keywords through and wraps a named function", () => {
    expect(mapResponsesToolChoice(undefined)).toBe("auto");
    expect(mapResponsesToolChoice("auto")).toBe("auto");
    expect(mapResponsesToolChoice("none")).toBe("none");
    expect(mapResponsesToolChoice("required")).toBe("required");
    expect(mapResponsesToolChoice("get_weather")).toEqual({
      type: "function",
      name: "get_weather",
    });
  });
});

describe("buildResponsesInput", () => {
  it("replays an assistant turn's native items verbatim instead of rebuilding it", () => {
    const items = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
      { type: "function_call", id: "fc_1", call_id: "c1", name: "look", arguments: "{}" },
    ];
    const { input } = buildResponsesInput({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }],
          native_items: items,
        },
        { role: "tool", tool_call_id: "c1", content: "looked" },
      ] as never,
    });
    expect(input).toEqual([
      { role: "user", content: "go" },
      ...items,
      { type: "function_call_output", call_id: "c1", output: "looked" },
    ]);
  });

  it("rebuilds the turn when its calls no longer match the native items", () => {
    const { input } = buildResponsesInput({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1-2", type: "function", function: { name: "look", arguments: "{}" } },
          ],
          native_items: [{ type: "function_call", call_id: "c1", name: "look", arguments: "{}" }],
        },
      ] as never,
    });
    expect(input).toEqual([
      { type: "function_call", call_id: "c1-2", name: "look", arguments: "{}" },
    ]);
  });

  it("uses the prompt string as input when there are no messages", () => {
    expect(buildResponsesInput({ prompt: "hello" })).toEqual({
      input: "hello",
      instructions: undefined,
    });
  });

  it("lifts systemPrompt into instructions", () => {
    expect(buildResponsesInput({ prompt: "hi", systemPrompt: "be terse" })).toEqual({
      input: "hi",
      instructions: "be terse",
    });
  });

  it("lifts system/developer messages into instructions and keeps the rest as input items", () => {
    const result = buildResponsesInput({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(result.instructions).toBe("you are helpful");
    expect(result.input).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("translates a tool-result message into a function_call_output item", () => {
    const result = buildResponsesInput({
      messages: [{ role: "tool", content: "72F and sunny", tool_call_id: "call_abc" }],
    });
    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "call_abc", output: "72F and sunny" },
    ]);
  });

  it("translates an assistant tool_calls message into function_call items", () => {
    const result = buildResponsesInput({
      messages: [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            { id: "call_abc", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
          ],
        },
      ],
    });
    expect(result.input).toEqual([
      { role: "assistant", content: "let me check" },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ]);
  });

  it("maps user image_url parts to Responses input_image parts", () => {
    const result = buildResponsesInput({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("coerces an unknown role to a user message", () => {
    const result = buildResponsesInput({ messages: [{ role: "weird", content: "hi" }] });
    expect(result.input).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("parseResponsesToolCalls", () => {
  it("extracts function_call items and ignores messages/reasoning", () => {
    const calls = parseResponsesToolCalls([
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ]);
    expect(calls).toEqual([{ id: "call_1", name: "get_weather", input: { city: "NYC" } }]);
  });

  it("falls back to a synthesized id and empty args", () => {
    const calls = parseResponsesToolCalls([{ type: "function_call", name: "fn", arguments: "" }]);
    expect(calls).toEqual([{ id: "call_0", name: "fn", input: {} }]);
  });
});

/**
 * `response.completed` used to fall into the `default:` arm and be discarded,
 * which threw away the only usage report the Responses API sends.
 */
describe("accumulateOpenAIResponsesStream usage", () => {
  async function usageOf(list: readonly unknown[]) {
    return accumulateOpenAIResponsesStream(events(list), () => {});
  }

  it("returns the token accounting from the terminal response.completed event", async () => {
    const usage = await usageOf([
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 120,
            output_tokens: 34,
            total_tokens: 154,
            input_tokens_details: { cached_tokens: 64, cache_write_tokens: 16 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      },
    ]);
    expect(usage).toEqual({
      input: 40,
      output: 34,
      cached: 64,
      cacheWrite: 16,
      reasoning: 20,
      total: 154,
      extra: undefined,
    });
  });

  it("returns undefined when the stream never reports usage", async () => {
    expect(
      await usageOf([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed" },
      ])
    ).toBeUndefined();
  });

  it("leaves counters the response omitted as undefined, never 0", async () => {
    const usage = await usageOf([
      { type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);
    expect(usage).toEqual({
      input: 7,
      output: 3,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    });
  });

  it("still records usage for an incomplete or failed response", async () => {
    for (const type of ["response.incomplete", "response.failed"]) {
      const usage = await usageOf([{ type, response: { usage: { input_tokens: 9 } } }]);
      expect(usage?.input, `${type} consumed tokens and must report them`).toBe(9);
    }
  });

  it("keeps a genuinely reported zero", async () => {
    const usage = await usageOf([
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    expect(usage?.input).toBe(0);
    expect(usage?.output).toBe(0);
  });

  it("emits a provisional ↑ estimate when promptText is supplied", async () => {
    const out: StreamEvent[] = [];
    await accumulateOpenAIResponsesStream(
      events([{ type: "response.output_text.delta", delta: "abcd" }]),
      (e) => out.push(e),
      { promptText: "abcd".repeat(310) } // 1240 chars → 310 tokens
    );
    const usageEvents = out.filter((e) => e.type === "usage");
    expect(usageEvents[0]).toMatchObject({
      type: "usage",
      usage: { input: 310, output: 0 },
    });
    expect(usageEvents.at(-1)).toMatchObject({
      type: "usage",
      usage: { input: 310, output: 1 },
    });
  });
});

describe("promptTextForResponsesUsageEstimate", () => {
  it("joins instructions with a string input", () => {
    expect(
      promptTextForResponsesUsageEstimate({
        instructions: "Be brief.",
        input: "hello",
      })
    ).toBe("Be brief.\nhello");
  });

  it("flattens string content from input items", () => {
    expect(
      promptTextForResponsesUsageEstimate({
        input: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      })
    ).toBe("one\ntwo");
  });
});
