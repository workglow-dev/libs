/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { ANTHROPIC, _testOnly } from "@workglow/anthropic/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/anthropic/ai-runtime";
import { getLogger } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ANTHROPIC_RUN_FNS, setAnthropicClientForTests } = _testOnly;

const MODEL_NAME = "claude-sonnet-5-5";
const NATIVE_KEY = `anthropic:${MODEL_NAME}`;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = ANTHROPIC_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const model = {
  model_id: MODEL_NAME,
  title: "",
  description: "",
  provider: ANTHROPIC,
  provider_config: { model_name: MODEL_NAME, api_key: "test-key" },
  capabilities: ["text.generation", "tool-use"],
  metadata: {},
} as never;

type Scripted = readonly unknown[] | Error;

const thinkingThenCall = [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Plan" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "SIG" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t1", name: "look", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"a":' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "1}" },
  },
  { type: "content_block_stop", index: 1 },
];

const signedBlocks = [
  { type: "thinking", thinking: "Plan", signature: "SIG" },
  { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
];

const turnMessages = (provider: string, toolUseId: string) => [
  { role: "user", content: [{ type: "text", text: "go" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", provider, payload: JSON.stringify(signedBlocks) },
      { type: "tool_use", id: toolUseId, name: "look", input: { a: 1 } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "ok" }] },
    ],
  },
];

const bindingError = () =>
  Object.assign(
    new Error(
      "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."
    ),
    { status: 400 }
  );

describe("Anthropic native turn", () => {
  let calls: Array<Record<string, any>>;
  let script: Scripted[];

  const install = () => {
    const fakeClient = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(structuredClone(params));
          const next = script.shift() ?? [];
          if (next instanceof Error) throw next;
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of next) yield event;
            },
          };
        },
      },
    };
    setAnthropicClientForTests(fakeClient);
    runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);
  };

  beforeEach(() => {
    calls = [];
    script = [];
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    install();
  });

  afterEach(() => {
    setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests?.(undefined);
    vi.restoreAllMocks();
  });

  async function run(messages: unknown[]): Promise<Array<Record<string, any>>> {
    const events: Array<Record<string, any>> = [];
    await toolCallingRunFn()(
      { model, prompt: "", messages, tools: [] } as never,
      model,
      undefined as never,
      ((event: Record<string, any>) => events.push(event)) as never
    );
    return events;
  }

  const nativeTurns = (events: Array<Record<string, any>>) =>
    events.filter((e) => e.type === "object-delta" && e.port === "nativeTurn");

  const sentAssistant = (call: Record<string, any>) =>
    (call.messages as Array<{ role: string; content: any[] }>).find((m) => m.role === "assistant")!;

  it("captures the reply's blocks in order, signature included", async () => {
    script = [thinkingThenCall];
    const events = await run([{ role: "user", content: [{ type: "text", text: "go" }] }]);
    const native = nativeTurns(events);
    expect(native).toHaveLength(1);
    expect(native[0]!.objectDelta).toEqual({
      provider: NATIVE_KEY,
      payload: JSON.stringify(signedBlocks),
    });
    expect(events.indexOf(native[0]!)).toBeLessThan(events.findIndex((e) => e.type === "finish"));
  });

  it("captures redacted thinking as it arrived", async () => {
    script = [
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "R" },
        },
        { type: "content_block_stop", index: 0 },
      ],
    ];
    const events = await run([{ role: "user", content: [{ type: "text", text: "go" }] }]);
    expect(nativeTurns(events)[0]!.objectDelta.payload).toBe(
      JSON.stringify([{ type: "redacted_thinking", data: "R" }])
    );
  });

  it("replays the captured turn verbatim while the tool calls still match", async () => {
    await run(turnMessages(NATIVE_KEY, "t1"));
    expect(sentAssistant(calls[0]!).content).toEqual(signedBlocks);
  });

  it("rebuilds the turn without thinking when a tool call id changed", async () => {
    await run(turnMessages(NATIVE_KEY, "t1-2"));
    expect(sentAssistant(calls[0]!).content).toEqual([
      { type: "tool_use", id: "t1-2", name: "look", input: { a: 1 } },
    ]);
  });

  it("rebuilds the turn without thinking when another model produced it", async () => {
    await run(turnMessages("anthropic:some-other-model", "t1"));
    expect(sentAssistant(calls[0]!).content).toEqual([
      { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
    ]);
  });

  it("strips thinking and retries once when Anthropic rejects the replayed signature", async () => {
    script = [bindingError(), thinkingThenCall];
    const events = await run(turnMessages(NATIVE_KEY, "t1"));
    expect(calls).toHaveLength(2);
    expect(sentAssistant(calls[0]!).content).toEqual(signedBlocks);
    expect(sentAssistant(calls[1]!).content).toEqual([
      { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
    ]);
    expect(events.some((e) => e.type === "finish")).toBe(true);
    expect(getLogger().warn).toHaveBeenCalledWith(
      "Anthropic rejected replayed thinking; retrying without it.",
      { model: MODEL_NAME }
    );
  });

  it("strips redacted thinking on the retry too", async () => {
    script = [bindingError(), []];
    const messages = turnMessages(NATIVE_KEY, "t1");
    (messages[1]!.content as unknown[])[0] = {
      type: "reasoning",
      text: "",
      provider: NATIVE_KEY,
      payload: JSON.stringify([
        { type: "redacted_thinking", data: "R" },
        { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
      ]),
    };
    await run(messages);
    expect(sentAssistant(calls[1]!).content).toEqual([
      { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
    ]);
  });

  it("does not loop: a second rejection is rethrown", async () => {
    script = [bindingError(), bindingError()];
    await expect(run(turnMessages(NATIVE_KEY, "t1"))).rejects.toThrow(/Invalid `signature`/);
    expect(calls).toHaveLength(2);
  });

  it("does not retry an unrelated 400", async () => {
    script = [Object.assign(new Error("max_tokens too large"), { status: 400 })];
    await expect(run(turnMessages(NATIVE_KEY, "t1"))).rejects.toThrow(/max_tokens/);
    expect(calls).toHaveLength(1);
  });
});
