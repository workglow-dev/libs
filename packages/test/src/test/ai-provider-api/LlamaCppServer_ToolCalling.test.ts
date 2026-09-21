/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import { createLlamaCppServerToolCallingStream } from "@workglow/llamacpp-server/ai-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

function sseChunks(chunks: object[]): Response {
  const enc = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n`).concat("data: [DONE]\n");
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => vi.restoreAllMocks());

const model = { provider_config: { base_url: "http://localhost:8080", model_name: "m" } } as any;
const TOOLS = [
  {
    name: "add",
    description: "add",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  },
];

describe("createLlamaCppServerToolCallingStream", () => {
  it("accumulates partial-JSON args across deltas and emits final tool calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseChunks([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c0", function: { name: "add", arguments: '{"a":1' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"b":2}' } }] } }],
        },
      ])
    );
    const fn = createLlamaCppServerToolCallingStream({});
    const events: any[] = [];
    const emit = (e: any) => events.push(e);
    await fn(
      { prompt: "p", tools: TOOLS, toolChoice: "auto" } as any,
      model,
      undefined as any,
      emit
    );
    // The repaired arguments arrive on the LAST object-delta, not on `finish`:
    // the parser is closed after the stream ends, so that delta is the first
    // time `{"a":1` and `,"b":2}` are one complete object. `finish` carries the
    // empty shape because `TaskRunner` accumulates the deltas.
    const toolCallDeltas = events.filter(
      (e) => e.type === "object-delta" && e.port === "toolCalls"
    );
    expect(toolCallDeltas.at(-1)!.objectDelta).toEqual([
      { id: "c0", name: "add", input: { a: 1, b: 2 } },
    ]);
    const finish = events.find((e) => e.type === "finish")!;
    expect(finish.data).toEqual({ text: "", toolCalls: [] });
  });

  it("keeps a tool name the model invented out of the stream entirely", async () => {
    // The delta fold is an upsert by id, so a call that reaches the consumer
    // cannot be retracted later — filtering has to happen before it is emitted,
    // not once at the end.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseChunks([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c0", function: { name: "rm_rf", arguments: "{}" } }],
              },
            },
          ],
        },
      ])
    );
    const fn = createLlamaCppServerToolCallingStream({});
    const events: any[] = [];
    await fn(
      { prompt: "p", tools: TOOLS, toolChoice: "auto" } as any,
      model,
      undefined as any,
      (e: any) => events.push(e)
    );
    const emitted = events
      .filter((e) => e.type === "object-delta" && e.port === "toolCalls")
      .flatMap((e) => e.objectDelta as Array<{ name: string }>);
    expect(emitted).toEqual([]);
  });

  it("omits tools[] when toolChoice='none'", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseChunks([{ choices: [{ delta: { content: "hi" } }] }]));
    const fn = createLlamaCppServerToolCallingStream({});
    const emit = (_e: any) => undefined;
    await fn(
      { prompt: "p", tools: TOOLS, toolChoice: "none" } as any,
      model,
      undefined as any,
      emit
    );
    const body = JSON.parse(asText((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.tools).toBeUndefined();
  });
});
