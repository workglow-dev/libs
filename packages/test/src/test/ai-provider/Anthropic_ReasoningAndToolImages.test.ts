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

function toolCallingRunFn(): AiProviderRunFn {
  const registration = ANTHROPIC_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const model = {
  model_id: "claude-sonnet-5-5",
  title: "",
  description: "",
  provider: ANTHROPIC,
  provider_config: { model_name: "claude-sonnet-5-5", api_key: "test-key" },
  capabilities: ["text.generation", "tool-use"],
  metadata: {},
} as never;

/**
 * A conversation another provider produced: its reasoning was streamed as text
 * and kept on the assistant turn, and a tool returned an image.
 */
const messages = [
  { role: "user", content: [{ type: "text", text: "What is on the board?" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I should look at the image." },
      { type: "tool_use", id: "c1", name: "read", input: { path: "board.png" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: [
          { type: "text", text: "Image: board.png" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
        is_error: undefined,
      },
    ],
  },
];

describe("Anthropic tool-calling request with reasoning and tool images", () => {
  let captured: Record<string, unknown>[];

  beforeEach(() => {
    captured = [];
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const fakeClient = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          captured.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              // No events: the run-fn finishes on an empty stream.
            },
          };
        },
      },
    };
    setAnthropicClientForTests(fakeClient);
    runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);
  });

  afterEach(() => {
    setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests?.(undefined);
    vi.restoreAllMocks();
  });

  it("drops reasoning blocks, which have no unsigned Anthropic form, and keeps tool images", async () => {
    await toolCallingRunFn()(
      { model, prompt: "", messages, tools: [] } as never,
      model,
      undefined as never,
      (() => {}) as never
    );
    expect(captured).toHaveLength(1);
    const sent = captured[0]!.messages as Array<{ role: string; content: unknown[] }>;
    const assistant = sent.find((message) => message.role === "assistant")!;
    expect(assistant.content).toEqual([
      { type: "tool_use", id: "c1", name: "read", input: { path: "board.png" } },
    ]);
    expect(JSON.stringify(sent)).not.toContain('"reasoning"');
    const toolResult = sent.at(-1)!.content[0] as { content: unknown[] };
    expect(toolResult.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });
});
