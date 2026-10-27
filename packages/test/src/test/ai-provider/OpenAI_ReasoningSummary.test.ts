/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { accumulateOpenAIResponsesStream } from "@workglow/ai/provider-utils";
import { OPENAI, _testOnly } from "@workglow/openai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/openai/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { OPENAI_RUN_FNS, finalizeResponsesRequest, requestReasoningSummary } = _testOnly;

const MODEL_NAME = "gpt-5.5";

const modelWith = (reasoning: Record<string, unknown> | undefined) =>
  ({
    model_id: MODEL_NAME,
    title: MODEL_NAME,
    description: "",
    provider: OPENAI,
    provider_config: {
      model_name: MODEL_NAME,
      api_key: "test-key",
      ...(reasoning ? { reasoning } : {}),
    },
    capabilities: ["text.generation", "tool-use"],
    metadata: {},
  }) as never;

async function* events(list: readonly unknown[]): AsyncIterable<unknown> {
  for (const e of list) yield e;
}

async function collect(list: readonly unknown[], forwardReasoning: boolean): Promise<any[]> {
  const out: any[] = [];
  await accumulateOpenAIResponsesStream(events(list), (e) => out.push(e), { forwardReasoning });
  return out;
}

const portText = (out: readonly any[], port: string): string =>
  out
    .filter((e) => e.type === "text-delta" && e.port === port)
    .map((e) => e.textDelta)
    .join("");

const summaryDelta = (itemId: string, summaryIndex: number, delta: string) => ({
  type: "response.reasoning_summary_text.delta",
  item_id: itemId,
  output_index: 0,
  summary_index: summaryIndex,
  delta,
});

describe("accumulateOpenAIResponsesStream reasoning summaries", () => {
  it("streams a summary on the reasoning port and never on text", async () => {
    const out = await collect(
      [
        summaryDelta("rs_1", 0, "Weighing "),
        summaryDelta("rs_1", 0, "the options."),
        { type: "response.output_text.delta", output_index: 1, delta: "Answer." },
        { type: "response.completed", response: {} },
      ],
      true
    );
    expect(portText(out, "reasoning")).toBe("Weighing the options.");
    expect(portText(out, "text")).toBe("Answer.");
  });

  it("puts a blank line between summary parts and between reasoning items", async () => {
    const out = await collect(
      [
        summaryDelta("rs_1", 0, "First part."),
        { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
        { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
        summaryDelta("rs_1", 1, "Second "),
        summaryDelta("rs_1", 1, "part."),
        summaryDelta("rs_2", 0, "Next item."),
      ],
      true
    );
    expect(portText(out, "reasoning")).toBe("First part.\n\nSecond part.\n\nNext item.");
  });

  it("drops summaries for a caller with no reasoning port", async () => {
    const out = await collect(
      [
        summaryDelta("rs_1", 0, "thinking"),
        { type: "response.output_text.delta", output_index: 1, delta: "hi" },
      ],
      false
    );
    expect(out).toEqual([{ type: "text-delta", port: "text", textDelta: "hi" }]);
  });
});

describe("accumulateOpenAIResponsesStream raw reasoning", () => {
  const reasoningTextDelta = (itemId: string, contentIndex: number, delta: string) => ({
    type: "response.reasoning_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: contentIndex,
    delta,
  });

  it("streams a compatible server's raw reasoning on the reasoning port, never on text", async () => {
    const out = await collect(
      [
        reasoningTextDelta("rs_1", 0, "The user wants "),
        reasoningTextDelta("rs_1", 0, "the weather."),
        reasoningTextDelta("rs_1", 1, "Call the tool."),
        summaryDelta("rs_1", 0, "Checking weather."),
        { type: "response.output_text.delta", output_index: 1, delta: "Answer." },
      ],
      true
    );
    expect(portText(out, "reasoning")).toBe(
      "The user wants the weather.\n\nCall the tool.\n\nChecking weather."
    );
    expect(portText(out, "text")).toBe("Answer.");
  });

  it("drops raw reasoning for a caller with no reasoning port", async () => {
    const out = await collect([reasoningTextDelta("rs_1", 0, "Thinking.")], false);
    expect(out.filter((e) => e.type === "text-delta")).toEqual([]);
  });
});

describe("requestReasoningSummary", () => {
  it("asks for nothing unless the model record opts in", () => {
    const params = finalizeResponsesRequest(modelWith({ effort: "high" }), { model: MODEL_NAME });
    requestReasoningSummary(modelWith({ effort: "high" }), params);
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("adds the opted-in summary beside the resolved effort", () => {
    const model = modelWith({ effort: "high", summary: "detailed" });
    const params = finalizeResponsesRequest(model, { model: MODEL_NAME });
    // finalize alone never asks: every other run-fn would drop the summary.
    expect(params.reasoning).toEqual({ effort: "high" });
    requestReasoningSummary(model, params);
    expect(params.reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  it("adds it to the class default effort when only the summary is configured", () => {
    const model = modelWith({ summary: "auto" });
    const params = requestReasoningSummary(
      model,
      finalizeResponsesRequest(model, { model: MODEL_NAME })
    );
    expect(params.reasoning).toMatchObject({ summary: "auto" });
    expect((params.reasoning as { effort?: string }).effort).not.toBe("none");
  });

  it("asks for no summary when reasoning is off", () => {
    const model = modelWith({ effort: "none", summary: "auto" });
    const params = requestReasoningSummary(
      model,
      finalizeResponsesRequest(model, { model: MODEL_NAME })
    );
    expect(params.reasoning).toEqual({ effort: "none" });
  });

  it("asks for no summary on a request without reasoning", () => {
    const params = requestReasoningSummary(modelWith({ summary: "auto" }), { model: "gpt-4.1" });
    expect(params.reasoning).toBeUndefined();
  });
});

describe("OpenAI run-fns and reasoning summaries", () => {
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
    _testOnly.setOpenAIClientForTests(fakeClient);
    runtimeTestOnly.setOpenAIClientForTests(fakeClient);
  });

  afterEach(() => {
    _testOnly.setOpenAIClientForTests(undefined);
    runtimeTestOnly.setOpenAIClientForTests(undefined);
  });

  const runFnServing = (capabilities: readonly string[]): AiProviderRunFn => {
    const registration = OPENAI_RUN_FNS.find(
      ({ serves }) =>
        (serves as readonly string[]).length === capabilities.length &&
        capabilities.every((c) => (serves as readonly string[]).includes(c))
    );
    expect(registration).toBeDefined();
    return registration!.runFn as AiProviderRunFn;
  };

  const reasoningItem = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "Thinking it over." }],
    encrypted_content: "ENC",
  };
  const turnEvents = [
    summaryDelta("rs_1", 0, "Thinking it over."),
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_text.delta", output_index: 1, delta: "Done." },
    { type: "response.completed", response: {} },
  ];

  it("tool calling asks for the summary, streams it on reasoning, and replays it verbatim", async () => {
    const model = modelWith({ effort: "high", summary: "auto" });
    streamEvents = turnEvents;
    const emitted: any[] = [];
    await runFnServing(["text.generation", "tool-use"])(
      {
        model,
        prompt: "",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        tools: [{ name: "look", description: "", inputSchema: {} }],
      } as never,
      model,
      new AbortController().signal,
      ((event: unknown) => emitted.push(event)) as never
    );
    expect(captured[0]!.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(captured[0]!.include).toEqual(["reasoning.encrypted_content"]);
    expect(portText(emitted, "reasoning")).toBe("Thinking it over.");
    expect(portText(emitted, "text")).toBe("Done.");
    const native = emitted.find((e) => e.type === "object-delta" && e.port === "nativeTurn");
    expect(JSON.parse(native.objectDelta.payload)[0]).toEqual(reasoningItem);
  });

  it("text generation asks for no summary and keeps a stray one off text", async () => {
    const model = modelWith({ effort: "high", summary: "auto" });
    streamEvents = turnEvents;
    const emitted: any[] = [];
    await runFnServing(["text.generation"])(
      { model, prompt: "go" } as never,
      model,
      new AbortController().signal,
      ((event: unknown) => emitted.push(event)) as never
    );
    expect(captured[0]!.reasoning).toEqual({ effort: "high" });
    expect(portText(emitted, "text")).toBe("Done.");
    expect(portText(emitted, "reasoning")).toBe("");
  });
});
