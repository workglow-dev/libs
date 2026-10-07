/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { accumulateOpenAIChatStream } from "@workglow/ai/provider-utils";
import { describe, expect, it } from "vitest";

/** Turn a fixed array of chat-completion chunks into the async iterable the accumulator consumes. */
async function* chunks(list: readonly unknown[]): AsyncIterable<any> {
  for (const c of list) yield c;
}

/** Collect the tool-call object-deltas the accumulator emits. */
async function toolCallDeltas(list: readonly unknown[]): Promise<any[]> {
  const out: any[] = [];
  await accumulateOpenAIChatStream(chunks(list), (e) => {
    if (e.type === "object-delta" && e.port === "toolCalls") out.push(e.objectDelta);
  });
  return out;
}

function toolCallChunk(toolCalls: readonly unknown[]): unknown {
  return { choices: [{ delta: { tool_calls: toolCalls } }] };
}

describe("accumulateOpenAIChatStream tool-call arguments", () => {
  it("assembles arguments fragmented across deltas", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([{ index: 0, id: "c0", function: { name: "add", arguments: '{"a":1' } }]),
      toolCallChunk([{ index: 0, function: { arguments: ',"b":' } }]),
      toolCallChunk([{ index: 0, function: { arguments: "2}" } }]),
    ]);
    expect(deltas.at(-1)).toEqual([{ id: "c0", name: "add", input: { a: 1, b: 2 } }]);
  });

  it("emits the arguments seen so far as each fragment arrives", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([{ index: 0, id: "c0", function: { name: "add", arguments: '{"a":1' } }]),
      toolCallChunk([{ index: 0, function: { arguments: ',"b":2}' } }]),
    ]);
    expect(deltas).toEqual([
      [{ id: "c0", name: "add", input: { a: 1 } }],
      [{ id: "c0", name: "add", input: { a: 1, b: 2 } }],
    ]);
  });

  it("keeps concurrent tool calls on separate parsers", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([
        { index: 0, id: "c0", function: { name: "add", arguments: '{"a":' } },
        { index: 1, id: "c1", function: { name: "sub", arguments: '{"x":' } },
      ]),
      toolCallChunk([
        { index: 1, function: { arguments: "9}" } },
        { index: 0, function: { arguments: "1}" } },
      ]),
    ]);
    expect(deltas.at(-2)).toEqual([{ id: "c1", name: "sub", input: { x: 9 } }]);
    expect(deltas.at(-1)).toEqual([{ id: "c0", name: "add", input: { a: 1 } }]);
  });

  it("keeps completed fields when the stream is cut mid-key", async () => {
    // A buffer ending on a closed key with no colon yet is the one position at
    // which whole-buffer repair gave up entirely; the incremental parser has
    // already committed the preceding fields and keeps them.
    const deltas = await toolCallDeltas([
      toolCallChunk([{ index: 0, id: "c0", function: { name: "add", arguments: '{"a":1,"b"' } }]),
    ]);
    expect(deltas.at(-1)).toEqual([{ id: "c0", name: "add", input: { a: 1 } }]);
  });

  it("drops a trailing incomplete value token", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([
        { index: 0, id: "c0", function: { name: "add", arguments: '{"a":1,"b":tru' } },
      ]),
    ]);
    expect(deltas.at(-1)).toEqual([{ id: "c0", name: "add", input: { a: 1 } }]);
  });

  it("re-emits the arguments so far for a delta carrying only an id", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([{ index: 0, function: { name: "add", arguments: '{"a":1}' } }]),
      toolCallChunk([{ index: 0, id: "c0" }]),
    ]);
    expect(deltas).toEqual([
      [{ id: "call_0", name: "add", input: { a: 1 } }],
      [{ id: "c0", name: "add", input: { a: 1 } }],
    ]);
  });

  it("emits an empty input for a tool call with no arguments", async () => {
    const deltas = await toolCallDeltas([
      toolCallChunk([{ index: 0, id: "c0", function: { name: "now" } }]),
    ]);
    expect(deltas.at(-1)).toEqual([{ id: "c0", name: "now", input: {} }]);
  });
});

describe("accumulateOpenAIChatStream reasoning", () => {
  it("streams reasoning_content and reasoning deltas to the reasoning port", async () => {
    const out: string[] = [];
    await accumulateOpenAIChatStream(
      chunks([
        { choices: [{ delta: { reasoning_content: "think " } }] },
        { choices: [{ delta: { reasoning: "more" } }] },
        { choices: [{ delta: { content: "answer" } }] },
      ]),
      (e) => {
        if (e.type === "text-delta") out.push(`${e.port}:${e.textDelta}`);
      }
    );
    expect(out).toEqual(["reasoning:think ", "reasoning:more", "text:answer"]);
  });
});
