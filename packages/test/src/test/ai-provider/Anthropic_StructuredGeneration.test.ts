/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { ANTHROPIC, _testOnly } from "@workglow/anthropic/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/anthropic/ai-runtime";
import { afterEach, describe, expect, it } from "vitest";

const { ANTHROPIC_RUN_FNS, setAnthropicClientForTests } = _testOnly;

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "number" } },
  required: ["name"],
} as const;

/** `toAnthropicOutputSchema` refuses a map-shaped object, so this takes the tool route. */
const INEXPRESSIBLE_SCHEMA = {
  type: "object",
  additionalProperties: { type: "number" },
} as const;

const runFn = ANTHROPIC_RUN_FNS.find(({ serves }) =>
  (serves as readonly string[]).includes("json-mode")
)!.runFn as AiProviderRunFn;

const modelConfig = (modelName: string, effort?: string) =>
  ({
    model_id: modelName,
    title: modelName,
    description: "",
    provider: ANTHROPIC,
    ...(effort === undefined ? {} : { effort }),
    provider_config: { model_name: modelName, api_key: "test-key" },
    capabilities: ["text.generation", "json-mode"],
    metadata: {},
  }) as never;

type StreamEvent = Record<string, unknown>;

const textDelta = (text: string): StreamEvent => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
});
const toolDelta = (partial_json: string): StreamEvent => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json },
});
const stop = (stop_reason: string): StreamEvent => ({
  type: "message_delta",
  delta: { stop_reason },
  usage: { output_tokens: 5 },
});

interface RunResult {
  readonly params: Record<string, unknown>;
  readonly object: unknown;
}

async function run(
  modelName: string,
  events: readonly StreamEvent[],
  schema: object = SCHEMA,
  effort?: string
): Promise<RunResult> {
  const captured: Record<string, unknown>[] = [];
  const fakeClient = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured.push(params);
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
        };
      },
    },
  };
  setAnthropicClientForTests(fakeClient);
  runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);

  const model = modelConfig(modelName, effort);
  const emitted: Array<{ type: string; data?: { object?: unknown } }> = [];
  await runFn(
    { model, prompt: "hi" } as never,
    model,
    undefined as never,
    ((event: { type: string }) => emitted.push(event)) as never,
    schema as never
  );
  expect(captured).toHaveLength(1);
  const finish = emitted.find((event) => event.type === "finish");
  expect(finish).toBeDefined();
  return { params: captured[0]!, object: finish!.data?.object };
}

describe("Anthropic_StructuredGeneration_Stream", () => {
  afterEach(() => {
    setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests?.(undefined);
  });

  describe("native output_config.format route", () => {
    it.each(["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-opus-5-5"])(
      "sends the format and no tool on %s",
      async (id) => {
        const { params, object } = await run(id, [
          textDelta('{"name":"Ada",'),
          textDelta('"age":36}'),
          stop("end_turn"),
        ]);
        const config = params.output_config as { format: { type: string; schema: unknown } };
        expect(config.format.type).toBe("json_schema");
        expect(config.format.schema).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
        expect("tools" in params).toBe(false);
        expect("tool_choice" in params).toBe(false);
        expect("system" in params).toBe(false);
        expect(object).toEqual({ name: "Ada", age: 36 });
      }
    );

    it("keeps the format when effort is merged into output_config", async () => {
      const { params } = await run("claude-opus-5-5", [textDelta("{}")], SCHEMA, "high");
      const config = params.output_config as { format?: unknown; effort?: unknown };
      expect(config.effort).toBe("high");
      expect(config.format).toBeDefined();
    });

    it("yields the partial object when the reply is cut off by max_tokens", async () => {
      // Neither route reads stop_reason: a truncated reply is passed on as the
      // partial object and the task's own schema validation rejects it.
      const { object } = await run("claude-opus-5-5", [
        textDelta('{"name":"Ada","ag'),
        stop("max_tokens"),
      ]);
      expect(object).toEqual({ name: "Ada" });
    });
  });

  describe("forced tool route", () => {
    it("forces the tool where the model accepts it and the format is unsupported", async () => {
      const { params, object } = await run("claude-sonnet-4-5", [
        toolDelta('{"name":"Ada"'),
        toolDelta(',"age":36}'),
        stop("tool_use"),
      ]);
      expect(params.tool_choice).toEqual({ type: "tool", name: "structured_output" });
      expect(params.tools).toHaveLength(1);
      expect("system" in params).toBe(false);
      expect("output_config" in params).toBe(false);
      expect(object).toEqual({ name: "Ada", age: 36 });
    });

    it("falls back to the tool when the schema cannot be expressed natively", async () => {
      const { params, object } = await run(
        "claude-opus-4-8",
        [toolDelta('{"a":1}')],
        INEXPRESSIBLE_SCHEMA
      );
      expect(params.tool_choice).toEqual({ type: "tool", name: "structured_output" });
      expect(object).toEqual({ a: 1 });
    });

    it("treats an unparseable id as the forced tool route", async () => {
      const { params } = await run("not-a-claude-id", [toolDelta("{}")]);
      expect(params.tool_choice).toEqual({ type: "tool", name: "structured_output" });
      expect("output_config" in params).toBe(false);
    });
  });

  describe("auto tool choice route", () => {
    // A generation-5 model with a schema the decoder cannot express: no native
    // format, and the model rejects a forced tool choice.
    const id = "claude-sonnet-5-5";

    it("offers the tool on auto with an instruction", async () => {
      const { params } = await run(id, [toolDelta('{"a":1}')], INEXPRESSIBLE_SCHEMA);
      expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
      expect(typeof params.system).toBe("string");
      expect("output_config" in params).toBe(false);
    });

    it("reads the tool input when the model calls the tool", async () => {
      const { object } = await run(
        id,
        [toolDelta('{"a":1,'), toolDelta('"b":2}')],
        INEXPRESSIBLE_SCHEMA
      );
      expect(object).toEqual({ a: 1, b: 2 });
    });

    it("reads JSON from text when the model answers in text", async () => {
      const { object } = await run(id, [textDelta('{"a":'), textDelta("3}")], INEXPRESSIBLE_SCHEMA);
      expect(object).toEqual({ a: 3 });
    });

    it("skips a text preamble before the JSON", async () => {
      const { object } = await run(
        id,
        [textDelta('Sure, here you go: {"a":4}')],
        INEXPRESSIBLE_SCHEMA
      );
      expect(object).toEqual({ a: 4 });
    });

    it("prefers the tool input over text when the model does both", async () => {
      const { object } = await run(
        id,
        [textDelta('Calling it. {"a":"from-text"}'), toolDelta('{"a":"from-tool"}')],
        INEXPRESSIBLE_SCHEMA
      );
      expect(object).toEqual({ a: "from-tool" });
    });
  });
});
