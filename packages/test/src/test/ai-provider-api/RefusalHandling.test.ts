/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI-shaped text run-fns report a refusal instead of completing with an
 * empty answer: `delta.refusal` streams as `refusal` events, a stream ended by
 * `finish_reason: "content_filter"` with no refusal text becomes one generic
 * refusal, and refusal text a failed attempt streamed can be taken back with a
 * `text-retract` on the reserved refusal port.
 */

import { collectStream } from "@workglow/ai";
import { createChatRefusalReader } from "@workglow/ai/provider-utils";
import { _testOnly } from "@workglow/huggingface-inference/ai";
import { createLlamaCppServerTextGenerationStream } from "@workglow/llamacpp-server/ai-runtime";
import type { StreamEvent } from "@workglow/task-graph";
import { REFUSAL_OUTPUT_KEY, Task, TaskRegistry } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { HFI_RUN_FNS, _setHfInferenceSDKForTesting } = _testOnly;

const refusalOf = (events: readonly any[]): string =>
  events
    .filter((e) => e.type === "refusal")
    .map((e) => e.refusal)
    .join("");

describe("createChatRefusalReader", () => {
  it("emits delta.refusal and nothing for ordinary content", () => {
    const events: any[] = [];
    const reader = createChatRefusalReader((e) => events.push(e));
    reader.read({ delta: { refusal: "I can't " } });
    reader.read({ delta: { refusal: "help." }, finish_reason: "stop" });
    reader.read({ delta: {} });
    expect(events).toEqual([
      { type: "refusal", refusal: "I can't " },
      { type: "refusal", refusal: "help." },
    ]);
  });

  it("turns a bare content_filter ending into one generic refusal", () => {
    const events: any[] = [];
    const reader = createChatRefusalReader((e) => events.push(e));
    reader.read({ delta: {}, finish_reason: "content_filter" });
    reader.read({ delta: {}, finish_reason: "content_filter" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "refusal", category: "output-refusal" });
  });

  it("does not add the generic refusal when the provider already said something", () => {
    const events: any[] = [];
    const reader = createChatRefusalReader((e) => events.push(e));
    reader.read({ delta: { refusal: "No." } });
    reader.read({ delta: {}, finish_reason: "content_filter" });
    expect(refusalOf(events)).toBe("No.");
  });
});

describe("HF Inference text run-fns", () => {
  let chunkQueue: unknown[] = [];
  async function* iter(items: readonly unknown[]): AsyncIterable<unknown> {
    for (const item of items) yield item;
  }
  class FakeInferenceClient {
    chatCompletionStream() {
      return iter(chunkQueue);
    }
  }
  const model = {
    model_id: "hfi-x",
    provider_config: { model_name: "meta-llama/Meta-Llama-3-8B-Instruct", api_key: "k" },
  } as any;
  const find = (key: string) => {
    const reg = HFI_RUN_FNS.find((r) => [...r.serves].sort().join(",") === key);
    if (!reg) throw new Error(`no HFI run-fn for ${key}`);
    return reg.runFn;
  };
  const cases = [
    { label: "text generation", serves: "text.generation", input: { prompt: "hi" } },
    { label: "rewriter", serves: "text.rewriter", input: { prompt: "p", text: "t" } },
    { label: "summary", serves: "text.summary", input: { text: "t" } },
  ] as const;

  beforeEach(() => {
    _setHfInferenceSDKForTesting({ InferenceClient: FakeInferenceClient } as never);
  });
  afterEach(() => {
    _setHfInferenceSDKForTesting(undefined as never);
  });

  for (const c of cases) {
    it(`${c.label}: a delta.refusal becomes a refusal event`, async () => {
      chunkQueue = [
        { choices: [{ delta: { refusal: "I can't " } }] },
        { choices: [{ delta: { refusal: "do that." }, finish_reason: "stop" }] },
      ];
      const events: any[] = [];
      await find(c.serves)(c.input as never, model, new AbortController().signal, (e: any) =>
        events.push(e)
      );
      expect(refusalOf(events)).toBe("I can't do that.");
      expect(events.at(-1).type).toBe("finish");
    });

    it(`${c.label}: an empty content_filter ending is reported as a refusal`, async () => {
      chunkQueue = [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }];
      const events: any[] = [];
      await find(c.serves)(c.input as never, model, new AbortController().signal, (e: any) =>
        events.push(e)
      );
      expect(events.filter((e) => e.type === "refusal")).toHaveLength(1);
    });

    it(`${c.label}: an ordinary answer carries no refusal`, async () => {
      chunkQueue = [
        { choices: [{ delta: { content: "fine" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ];
      const events: any[] = [];
      await find(c.serves)(c.input as never, model, new AbortController().signal, (e: any) =>
        events.push(e)
      );
      expect(events.some((e) => e.type === "refusal")).toBe(false);
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.textDelta)).toEqual([
        "fine",
      ]);
    });
  }
});

describe("llamacpp-server text generation", () => {
  const model = { provider_config: { base_url: "http://localhost:8080", model_name: "m" } } as any;
  const sse = (...payloads: unknown[]): Response => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const p of payloads) controller.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n`));
        controller.enqueue(enc.encode("data: [DONE]\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  afterEach(() => vi.restoreAllMocks());

  it("reports delta.refusal as a refusal event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sse(
        { choices: [{ delta: { refusal: "Not " } }] },
        { choices: [{ delta: { refusal: "allowed." }, finish_reason: "stop" }] }
      )
    );
    const events: any[] = [];
    await createLlamaCppServerTextGenerationStream({})(
      { prompt: "hi" } as any,
      model,
      undefined as any,
      (e: any) => events.push(e)
    );
    expect(refusalOf(events)).toBe("Not allowed.");
  });

  it("reports an empty content_filter ending as a refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sse({ choices: [{ delta: {}, finish_reason: "content_filter" }] })
    );
    const events: any[] = [];
    await createLlamaCppServerTextGenerationStream({})(
      { prompt: "hi" } as any,
      model,
      undefined as any,
      (e: any) => events.push(e)
    );
    expect(events.filter((e) => e.type === "refusal")).toHaveLength(1);
  });
});

describe("taking back refusal text", () => {
  type Out = { text: string };
  const SCHEMA = {
    type: "object",
    properties: { text: { type: "string", "x-stream": "append" } },
    additionalProperties: false,
  } as const satisfies DataPortSchema;

  class Scripted extends Task<Record<string, never>, Out> {
    public static override type = "RefusalRetractTest_Scripted";
    public static override category = "Test";
    public static override cacheable = false;
    public script: readonly StreamEvent<Out>[] = [];
    public static override outputSchema(): DataPortSchema {
      return SCHEMA;
    }
    async *executeStream(): AsyncIterable<StreamEvent<Out>> {
      for (const event of this.script) yield event;
    }
  }
  beforeAll(() => {
    TaskRegistry.registerTask(Scripted as never);
  });

  const script: StreamEvent<any>[] = [
    { type: "refusal", refusal: "I can't ", category: "output-refusal" },
    { type: "text-retract", port: REFUSAL_OUTPUT_KEY, length: 8 },
    { type: "refusal", refusal: "Not now." },
    { type: "finish", data: {} },
  ];

  it("StreamProcessor leaves only the retried attempt's refusal", async () => {
    const task = new Scripted({});
    task.script = script;
    const out = (await task.run({})) as Record<string, unknown>;
    expect(out[REFUSAL_OUTPUT_KEY]).toBe("Not now.");
  });

  it("StreamProcessor drops the refusal and its category when all of it is taken back", async () => {
    const task = new Scripted({});
    task.script = [
      { type: "refusal", refusal: "No.", category: "output-refusal" },
      { type: "text-retract", port: REFUSAL_OUTPUT_KEY, length: 3 },
      { type: "text-delta", port: "text", textDelta: "answer" },
      { type: "finish", data: {} },
    ];
    const out = (await task.run({})) as Record<string, unknown>;
    expect(out[REFUSAL_OUTPUT_KEY]).toBeUndefined();
    expect(out.refusalCategory).toBeUndefined();
    expect(out.text).toBe("answer");
  });

  it("the stream accumulator folds it the same way", async () => {
    async function* events(): AsyncIterable<StreamEvent<any>> {
      for (const e of script) yield e;
    }
    const out = (await collectStream<any>(events())) as Record<string, unknown>;
    expect(out[REFUSAL_OUTPUT_KEY]).toBe("Not now.");
  });
});
