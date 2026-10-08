/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { OPENAI, _testOnly } from "@workglow/openai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/openai/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { OPENAI_RUN_FNS, setOpenAIClientForTests } = _testOnly;

function toolCallingRunFn(): AiProviderRunFn {
  const registration = OPENAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("tool-use")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const modelWith = (providerConfig: Record<string, unknown>) =>
  ({
    model_id: "gpt-5.5",
    title: "gpt-5.5",
    description: "",
    provider: OPENAI,
    provider_config: {
      model_name: "gpt-5.5",
      api_key: "test-key",
      reasoning: { effort: "high" },
      ...providerConfig,
    },
    capabilities: ["text.generation", "tool-use"],
    metadata: {},
  }) as never;

const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" };
const callItem = {
  type: "function_call",
  id: "fc_1",
  call_id: "c1",
  name: "look",
  arguments: "{}",
};

const messages = [
  { role: "user", content: [{ type: "text", text: "go" }] },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "",
        provider: "openai",
        payload: JSON.stringify([reasoningItem, callItem]),
      },
      { type: "tool_use", id: "c1", name: "look", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: [{ type: "text", text: "looked" }],
        is_error: undefined,
      },
    ],
  },
];

describe("OpenAI tool-calling native turn", () => {
  let captured: Record<string, unknown>[];
  let streamEvents: unknown[];

  beforeEach(() => {
    captured = [];
    streamEvents = [];
    const fakeClient = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          captured.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of streamEvents) yield event;
            },
          };
        },
      },
    };
    setOpenAIClientForTests(fakeClient);
    runtimeTestOnly.setOpenAIClientForTests(fakeClient);
  });

  afterEach(() => {
    setOpenAIClientForTests(undefined);
    runtimeTestOnly.setOpenAIClientForTests(undefined);
  });

  const run = async (model: never, emitted: unknown[] = []): Promise<Record<string, unknown>> => {
    await toolCallingRunFn()(
      {
        model,
        prompt: "",
        messages,
        tools: [{ name: "look", description: "", inputSchema: {} }],
      } as never,
      model,
      undefined as never,
      ((event: unknown) => emitted.push(event)) as never
    );
    expect(captured).toHaveLength(1);
    return captured[0]!;
  };

  it("asks for the encrypted reasoning when the model reasons", async () => {
    const params = await run(modelWith({}));
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("asks for nothing extra when replay is switched off", async () => {
    const params = await run(modelWith({ replay_reasoning: false }));
    expect(params).not.toHaveProperty("include");
    expect(JSON.stringify(params.input)).not.toContain("ENC");
  });

  it("asks for nothing extra when reasoning is off", async () => {
    const params = await run(modelWith({ reasoning: { effort: "none" } }));
    expect(params).not.toHaveProperty("include");
  });

  it("replays the native items it produced earlier", async () => {
    const params = await run(modelWith({}));
    expect(params.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      reasoningItem,
      callItem,
      { type: "function_call_output", call_id: "c1", output: "looked" },
    ]);
  });

  it("emits the turn's items as the native turn", async () => {
    streamEvents = [
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      { type: "response.output_item.done", output_index: 1, item: callItem },
      { type: "response.completed", response: {} },
    ];
    const emitted: Array<{ type: string; port?: string }> = [];
    await run(modelWith({}), emitted);
    expect(emitted.find((e) => e.port === "nativeTurn")).toEqual({
      type: "object-delta",
      port: "nativeTurn",
      objectDelta: { provider: "openai", payload: JSON.stringify([reasoningItem, callItem]) },
    });
  });

  it("emits no native turn when replay is switched off", async () => {
    streamEvents = [{ type: "response.output_item.done", output_index: 0, item: reasoningItem }];
    const emitted: Array<{ type: string; port?: string }> = [];
    await run(modelWith({ replay_reasoning: false }), emitted);
    expect(emitted.some((e) => e.port === "nativeTurn")).toBe(false);
  });
});
