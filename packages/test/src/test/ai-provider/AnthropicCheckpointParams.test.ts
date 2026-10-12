/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  AiSessionContext,
  TextGenerationTaskInput,
  ToolCallingTaskInput,
} from "@workglow/ai";
import { _testOnly } from "@workglow/anthropic/ai";
import {
  annotateLastBlock,
  applyAnthropicPrefixReplay,
  buildAnthropicCheckpointParams,
  _testOnly as runtimeTestOnly,
} from "@workglow/anthropic/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const prefix = {
  systemPrompt: "sys",
  tools: [{ name: "a", description: "A", inputSchema: { type: "object" as const } }],
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
  ],
};

describe("buildAnthropicCheckpointParams", () => {
  it("marks system, last tool, and last prefix message with cache_control", () => {
    const params = buildAnthropicCheckpointParams(prefix, "claude-x");
    expect(params.max_tokens).toBe(1);
    expect((params.system as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    const tools = params.tools as any[];
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    const msgs = params.messages as any[];
    const lastBlocks = msgs[msgs.length - 1].content as any[];
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds a throwaway user message when the prefix has none", () => {
    const params = buildAnthropicCheckpointParams({ systemPrompt: "sys" }, "claude-x");
    expect((params.messages as any[]).length).toBe(1);
    expect((params.messages as any[])[0].role).toBe("user");
  });
});

describe("annotateLastBlock", () => {
  it("annotates the last block of array content", () => {
    const message = {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    annotateLastBlock(message);
    expect(message.content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("lifts non-empty string content into an annotated text block array", () => {
    const message: { content: unknown } = { content: "tail" };
    annotateLastBlock(message);
    expect(message.content).toEqual([
      { type: "text", text: "tail", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("leaves empty content untouched", () => {
    const emptyString: { content: unknown } = { content: "" };
    annotateLastBlock(emptyString);
    expect(emptyString.content).toBe("");

    const emptyArray: { content: unknown } = { content: [] };
    annotateLastBlock(emptyArray);
    expect(emptyArray.content).toEqual([]);
  });
});

describe("applyAnthropicPrefixReplay", () => {
  it("prepends prefix messages and marks the checkpoint boundary", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
    };
    applyAnthropicPrefixReplay(params, session);
    const msgs = params.messages as any[];
    expect(msgs).toHaveLength(3);
    // boundary annotation on the last block of the last PREFIX message
    const boundaryBlocks = msgs[1].content as any[];
    expect(boundaryBlocks[boundaryBlocks.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
    // tail not annotated (no emitCheckpointId)
    const tailBlocks = msgs[2].content as any[];
    expect(tailBlocks[tailBlocks.length - 1].cache_control).toBeUndefined();
    // system from prefix applied with cache_control
    expect((params.system as any[])[0].text).toBe("sys");
  });

  it("replays a prefix turn's signed thinking for the model that wrote it", () => {
    const thinking = { type: "thinking", thinking: "plan", signature: "SIG" };
    const turn = (provider: string) => ({
      ...prefix,
      messages: [
        prefix.messages[0]!,
        {
          role: "assistant" as const,
          content: [
            {
              type: "reasoning" as const,
              text: "plan",
              provider,
              payload: JSON.stringify([thinking, { type: "text", text: "hi" }]),
            },
            { type: "text" as const, text: "hi" },
          ],
        },
      ],
    });
    const replay = (provider: string): any[] => {
      const params: Record<string, unknown> = {
        model: "claude-x",
        messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
      };
      applyAnthropicPrefixReplay(params, { sessionId: "ckpt", prefix: turn(provider) });
      return (params.messages as any[])[1].content;
    };
    expect(replay("anthropic:claude-x")[0]).toEqual(thinking);
    expect(replay("anthropic:other")[0]).toEqual({
      type: "text",
      text: "hi",
      cache_control: { type: "ephemeral" },
    });
    const warm = buildAnthropicCheckpointParams(turn("anthropic:claude-x") as any, "claude-x");
    expect((warm.messages as any[])[1].content[0]).toEqual(thinking);
  });

  it("annotates the final turn when emitting a chained checkpoint", () => {
    const session: AiSessionContext = { sessionId: "ckpt", emitCheckpointId: "next", prefix };
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
    };
    applyAnthropicPrefixReplay(params, session);
    const msgs = params.messages as any[];
    const tailBlocks = msgs[msgs.length - 1].content as any[];
    expect(tailBlocks[tailBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("annotates a string-content tail at the emit boundary", () => {
    const session: AiSessionContext = { sessionId: "ckpt", emitCheckpointId: "next", prefix };
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: "tail" }],
    };
    applyAnthropicPrefixReplay(params, session);
    const msgs = params.messages as any[];
    expect(msgs[msgs.length - 1].content).toEqual([
      { type: "text", text: "tail", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("replays the prefix tools with the warm-up mapping when the caller has none", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
    };
    applyAnthropicPrefixReplay(params, session);
    const warmUp = buildAnthropicCheckpointParams(prefix, "claude-x");
    expect(params.tools).toEqual(warmUp.tools);
    expect((params.tools as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    // tool_choice left unset — API default auto
    expect(params.tool_choice).toBeUndefined();
  });

  it("keeps the caller's tools when it declares any", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const callerTools = [{ name: "mine", description: "Mine", input_schema: { type: "object" } }];
    const params: Record<string, unknown> = { tools: callerTools, messages: [] };
    applyAnthropicPrefixReplay(params, session);
    expect((params.tools as any[]).map((t) => t.name)).toEqual(["mine"]);
  });

  it("drops empty text blocks and empty assistant messages from the replayed prefix", () => {
    const messyPrefix = {
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "" }] },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "" },
            { type: "text" as const, text: "hi" },
          ],
        },
      ],
    };
    const session: AiSessionContext = { sessionId: "ckpt", prefix: messyPrefix };
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
    };
    applyAnthropicPrefixReplay(params, session);
    const msgs = params.messages as any[];
    // fully-empty assistant message dropped; empty text block filtered out
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toEqual([
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
    expect(msgs[2].content).toEqual([{ type: "text", text: "tail" }]);
  });
});

/**
 * Request-level coverage: drive the real run-fns through the client test seam
 * and assert on the exact params handed to `messages.stream`. The seam is set
 * on both the `ai` and `ai-runtime` entrypoints because the dist build splits
 * them into bundles with independent module state.
 */
describe("Anthropic run-fn request params", () => {
  const anthropicRequests: Array<Record<string, unknown>> = [];
  const fakeAnthropicClient = {
    messages: {
      stream: (request: Record<string, unknown>) => {
        anthropicRequests.push(request);
        return { async *[Symbol.asyncIterator]() {} };
      },
      create: async (request: Record<string, unknown>) => {
        anthropicRequests.push(request);
        return {};
      },
    },
  } as never;

  const testModel = { provider_config: { model_name: "claude-test" } } as never;

  beforeEach(() => {
    anthropicRequests.length = 0;
    _testOnly.setAnthropicClientForTests(fakeAnthropicClient);
    runtimeTestOnly.setAnthropicClientForTests(fakeAnthropicClient);
  });

  afterEach(() => {
    _testOnly.setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests(undefined);
  });

  /** Registration lookup — first entry whose `serves` includes the capability. */
  function findAnthropicRunFn(capability: string): AiProviderRunFn {
    const registration = _testOnly.ANTHROPIC_RUN_FNS.find(({ serves }) =>
      (serves as readonly string[]).includes(capability)
    );
    expect(registration).toBeDefined();
    return registration!.runFn as AiProviderRunFn;
  }

  it("text generation consuming a tools-warmed checkpoint sends the warm-up tool mapping", async () => {
    const runFn = findAnthropicRunFn("text.generation");
    const input: TextGenerationTaskInput = { model: "claude-test", prompt: "tail" };
    await runFn(input, testModel, new AbortController().signal, () => {}, undefined, {
      sessionId: "ckpt",
      prefix,
    });

    expect(anthropicRequests).toHaveLength(1);
    const request = anthropicRequests[0];
    const warmUp = buildAnthropicCheckpointParams(prefix, "claude-test");
    expect(request.tools).toEqual(warmUp.tools);
    expect(request.tool_choice).toBeUndefined();
    const msgs = request.messages as any[];
    expect(msgs).toHaveLength(3);
    expect(msgs[2].content).toBe("tail");
  });

  it("emit-only text generation (prompt path) carries system + boundary breakpoints", async () => {
    const runFn = findAnthropicRunFn("text.generation");
    const input = {
      model: "claude-test",
      prompt: "hello world",
      systemPrompt: "sys",
    } as unknown as TextGenerationTaskInput;
    await runFn(input, testModel, new AbortController().signal, () => {}, undefined, {
      emitCheckpointId: "em-1",
    });

    expect(anthropicRequests).toHaveLength(1);
    const request = anthropicRequests[0];
    expect(request.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello world", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("emit-only tool calling carries system + last-tool + boundary breakpoints", async () => {
    const runFn = findAnthropicRunFn("tool-use");
    const input: ToolCallingTaskInput = {
      model: "claude-test",
      prompt: "do it",
      systemPrompt: "sys",
      tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }],
    };
    await runFn(input, testModel, new AbortController().signal, () => {}, undefined, {
      emitCheckpointId: "em-2",
    });

    expect(anthropicRequests).toHaveLength(1);
    const request = anthropicRequests[0];
    expect(request.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    const tools = request.tools as any[];
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("tool calling with an empty tool list falls back to the prefix tools", async () => {
    const runFn = findAnthropicRunFn("tool-use");
    const input: ToolCallingTaskInput = {
      model: "claude-test",
      prompt: "tail",
      tools: [],
    };
    await runFn(input, testModel, new AbortController().signal, () => {}, undefined, {
      sessionId: "ckpt",
      prefix,
    });

    expect(anthropicRequests).toHaveLength(1);
    const request = anthropicRequests[0];
    const warmUp = buildAnthropicCheckpointParams(prefix, "claude-test");
    expect(request.tools).toEqual(warmUp.tools);
    const msgs = request.messages as any[];
    expect(msgs).toHaveLength(3);
  });
});
