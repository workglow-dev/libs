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

/**
 * The three legacy-thinking constraints are enforced across two helpers and the
 * order in which each run-fn calls them, so unit-testing the helpers alone
 * cannot prove the request that actually goes on the wire is well formed. This
 * suite captures the params object handed to the SDK client.
 */
function findRunFn(serves: readonly string[]): AiProviderRunFn {
  const registration = ANTHROPIC_RUN_FNS.find(
    ({ serves: candidate }) =>
      (candidate as readonly string[]).length === serves.length &&
      serves.every((capability) => (candidate as readonly string[]).includes(capability))
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

/** `claude-haiku-4-5` is on the legacy thinking path AND accepts sampling. */
const modelConfig = (effort: string, modelName = "claude-haiku-4-5") =>
  ({
    model_id: modelName,
    title: modelName,
    description: "",
    provider: ANTHROPIC,
    effort,
    provider_config: { model_name: modelName, api_key: "test-key" },
    capabilities: ["text.generation"],
    metadata: {},
  }) as never;

describe("Anthropic legacy thinking request shape", () => {
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
              // No events: every run-fn tolerates an empty stream and finishes.
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

  it("sends a legal budget and no temperature for effort low with temperature pinned", async () => {
    const runFn = findRunFn(["text.generation"]);
    const model = modelConfig("low");
    await runFn(
      { model, prompt: "hi", temperature: 0 } as never,
      model,
      undefined as never,
      (() => {}) as never
    );

    expect(captured).toHaveLength(1);
    const params = captured[0]!;
    // 512 (the `low` budget) is below Anthropic's 1024 minimum and is a 400.
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    // Extended thinking rejects sampling parameters even on a model that
    // otherwise accepts them.
    expect("temperature" in params).toBe(false);
    expect("top_p" in params).toBe(false);
  });

  it("omits thinking entirely on the structured-generation tool path", async () => {
    const runFn = findRunFn(["text.generation", "json-mode"]);
    // Sonnet 4.5 has no native structured outputs, so it takes the forced tool.
    const model = modelConfig("high", "claude-sonnet-4-5");
    await runFn(
      { model, prompt: "hi" } as never,
      model,
      undefined as never,
      (() => {}) as never,
      { type: "object", properties: { a: { type: "string" } } } as never
    );

    expect(captured).toHaveLength(1);
    const params = captured[0]!;
    // The tool route forces `tool_choice: {type: "tool"}`, which cannot carry
    // legacy extended thinking.
    expect(params.tool_choice).toEqual({ type: "tool", name: "structured_output" });
    expect("thinking" in params).toBe(false);
  });

  it("omits thinking on a tool-calling run that forces a tool", async () => {
    const runFn = findRunFn(["text.generation", "tool-use"]);
    const model = modelConfig("high");
    const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }];
    await runFn(
      { model, prompt: "hi", tools, toolChoice: "required", temperature: 0 } as never,
      model,
      undefined as never,
      (() => {}) as never
    );

    expect(captured).toHaveLength(1);
    const params = captured[0]!;
    expect(params.tool_choice).toEqual({ type: "any" });
    expect("thinking" in params).toBe(false);
    // No thinking on the request, so sampling is legal again on this model.
    expect(params.temperature).toBe(0);
  });

  it("keeps thinking and drops sampling on an auto tool-calling run", async () => {
    const runFn = findRunFn(["text.generation", "tool-use"]);
    const model = modelConfig("high");
    const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }];
    await runFn(
      { model, prompt: "hi", tools, toolChoice: "auto", temperature: 0 } as never,
      model,
      undefined as never,
      (() => {}) as never
    );

    const params = captured[0]!;
    // `auto` is not a forced choice, so thinking survives — and suppresses
    // sampling in turn.
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect("temperature" in params).toBe(false);
  });

  it("leaves an adaptive-thinking model's sampling parameters alone", async () => {
    const runFn = findRunFn(["text.generation"]);
    // `claude-sonnet-4-6` is on the adaptive path and still accepts sampling.
    const model = modelConfig("high", "claude-sonnet-4-6");
    await runFn(
      { model, prompt: "hi", temperature: 0.5 } as never,
      model,
      undefined as never,
      (() => {}) as never
    );

    const params = captured[0]!;
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.temperature).toBe(0.5);
  });
  it("offers the structured-output tool on auto where forced tool choice is a 400", async () => {
    const runFn = findRunFn(["text.generation", "json-mode"]);
    const model = modelConfig("high", "claude-opus-5-5");
    // A map-shaped object has no native structured-output form, so even a model
    // that supports it takes the tool route, and this one cannot force it.
    await runFn(
      { model, prompt: "hi" } as never,
      model,
      undefined as never,
      (() => {}) as never,
      { type: "object", additionalProperties: { type: "string" } } as never
    );

    const params = captured[0]!;
    expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(typeof params.system).toBe("string");
    expect(params.thinking).toEqual({ type: "adaptive" });
  });

  it("relaxes a required tool choice to auto where forced tool choice is a 400", async () => {
    const runFn = findRunFn(["text.generation", "tool-use"]);
    const model = modelConfig("high", "claude-sonnet-5-5");
    const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }];
    await runFn(
      { model, prompt: "hi", tools, toolChoice: "required" } as never,
      model,
      undefined as never,
      (() => {}) as never
    );

    expect(captured[0]!.tool_choice).toEqual({ type: "auto" });
  });

  it.each([
    ["claude-opus-5-5", { output_config: { effort: "low" } }],
    ["claude-fable-5-1", { output_config: { effort: "low" } }],
    ["claude-sonnet-5-5", { thinking: { type: "between_tools" } }],
  ])("sends the minimal thinking setting for effort none on %s", async (name, expected) => {
    const runFn = findRunFn(["text.generation"]);
    const model = modelConfig("none", name);
    await runFn({ model, prompt: "hi" } as never, model, undefined as never, (() => {}) as never);

    expect(captured[0]).toMatchObject(expected);
  });
});

describe("Anthropic native structured outputs", () => {
  let captured: Record<string, unknown>[];
  let replyText: string;

  beforeEach(() => {
    captured = [];
    replyText = "";
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const fakeClient = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          captured.push(params);
          const chunks = [replyText.slice(0, 5), replyText.slice(5)].filter((c) => c !== "");
          return {
            async *[Symbol.asyncIterator]() {
              for (const text of chunks) {
                yield { type: "content_block_delta", delta: { type: "text_delta", text } };
              }
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

  const SCHEMA = {
    type: "object",
    properties: { name: { type: "string", maxLength: 200 }, age: { type: "integer", minimum: 0 } },
    required: ["name"],
  };

  it("constrains the reply with output_config.format and offers no tool", async () => {
    const runFn = findRunFn(["text.generation", "json-mode"]);
    const model = modelConfig("high", "claude-opus-5-5");
    await runFn(
      { model, prompt: "hi" } as never,
      model,
      undefined as never,
      (() => {}) as never,
      SCHEMA as never
    );

    const params = captured[0]!;
    expect("tools" in params).toBe(false);
    expect("tool_choice" in params).toBe(false);
    const outputConfig = params.output_config as Record<string, unknown>;
    // Effort sits beside the format rather than replacing it.
    expect(outputConfig.effort).toBeDefined();
    expect(outputConfig.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });

  it("keeps thinking, which a forced tool could not carry", async () => {
    const runFn = findRunFn(["text.generation", "json-mode"]);
    const model = modelConfig("high");
    await runFn(
      { model, prompt: "hi" } as never,
      model,
      undefined as never,
      (() => {}) as never,
      SCHEMA as never
    );
    const params = captured[0]!;
    expect((params.output_config as Record<string, unknown>).format).toBeDefined();
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: expect.any(Number) });
  });

  it("reads the object from the streamed text", async () => {
    replyText = '{"name":"Jane Doe","age":41}';
    const runFn = findRunFn(["text.generation", "json-mode"]);
    const model = modelConfig("high", "claude-sonnet-5-5");
    const events: { type: string; data?: { object?: unknown } }[] = [];
    await runFn(
      { model, prompt: "hi" } as never,
      model,
      undefined as never,
      ((event: { type: string }) => events.push(event)) as never,
      SCHEMA as never
    );
    expect(events.some((e) => e.type === "object-delta")).toBe(true);
    expect(events.find((e) => e.type === "finish")?.data?.object).toEqual({
      name: "Jane Doe",
      age: 41,
    });
  });
});
