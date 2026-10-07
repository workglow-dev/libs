/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmitQueue } from "@workglow/ai";
import { createOllamaTextGenerationStream } from "@workglow/ollama/ai-runtime";
import { describe, expect, it, vi } from "vitest";

type FakeStream = {
  abort: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<{ message: { content: string } }>;
};

function makeFakeStream(chunks: string[]): FakeStream {
  let aborted = false;
  const abort = vi.fn(() => {
    aborted = true;
  });
  return {
    abort,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        if (aborted) return;
        yield { message: { content: c } };
      }
    },
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  return typeof e.message === "string" && e.message.toLowerCase().includes("abort");
}

describe("createOllamaTextGenerationStream abort behavior", () => {
  const model = {
    model_id: "ollama:test",
    provider_config: { model_name: "llama3.2" },
  } as any;
  const input = { prompt: "hi" } as any;

  it("yields zero deltas and aborts the stream when signal aborts during chat() (pre-attach race)", async () => {
    const fakeStream = makeFakeStream(["a", "b", "c"]);
    const controller = new AbortController();
    const getClient = vi.fn().mockResolvedValue({
      chat: vi.fn().mockImplementation(async () => {
        // Simulate the signal aborting after the pre-call throwIfAborted check
        // but before the abort listener is attached — the bug class this fix targets.
        controller.abort();
        return fakeStream;
      }),
    });
    const streamFn = createOllamaTextGenerationStream(getClient);

    const events: any[] = [];
    let caught: unknown;
    const q = createEmitQueue<any>();
    const runP = streamFn(input, model, controller.signal, (e) => q.push(e)).then(
      () => q.close(),
      (e) => q.fail(e)
    );
    try {
      for await (const ev of q.iterable) {
        events.push(ev);
      }
    } catch (err) {
      caught = err;
    }
    await runP;

    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas).toHaveLength(0);
    expect(fakeStream.abort).toHaveBeenCalledTimes(1);
    // post-attach throwIfAborted should propagate the abort as an AbortError
    expect(isAbortError(caught)).toBe(true);
  });

  it("does not throw when signal is undefined", async () => {
    const fakeStream = makeFakeStream(["hello", " world"]);
    const getClient = vi.fn().mockResolvedValue({
      chat: vi.fn().mockResolvedValue(fakeStream),
    });
    const streamFn = createOllamaTextGenerationStream(getClient);

    const events: any[] = [];
    const q = createEmitQueue<any>();
    await Promise.all([
      streamFn(input, model, undefined as any, (e) => q.push(e)).then(
        () => q.close(),
        (e) => q.fail(e)
      ),
      (async () => {
        for await (const ev of q.iterable) {
          events.push(ev);
        }
      })(),
    ]);

    const deltas = events.filter((e) => e.type === "text-delta").map((e) => (e as any).textDelta);
    expect(deltas).toEqual(["hello", " world"]);
    expect(events[events.length - 1]).toEqual({ type: "finish", data: {} });
    expect(fakeStream.abort).not.toHaveBeenCalled();
  });

  it("calls fakeStream.abort exactly once when signal is aborted mid-iteration", async () => {
    const chunks = ["one", "two", "three", "four", "five"];
    const fakeStream = makeFakeStream(chunks);
    const getClient = vi.fn().mockResolvedValue({
      chat: vi.fn().mockResolvedValue(fakeStream),
    });
    const streamFn = createOllamaTextGenerationStream(getClient);

    const controller = new AbortController();
    const deltas: string[] = [];

    const q = createEmitQueue<any>();
    const runP = streamFn(input, model, controller.signal, (e) => q.push(e)).then(
      () => q.close(),
      () => q.close()
    );
    for await (const ev of q.iterable) {
      if (ev.type === "text-delta") {
        deltas.push(ev.textDelta);
        if (deltas.length === 2) {
          controller.abort();
        }
      }
    }
    await runP;

    expect(fakeStream.abort).toHaveBeenCalledTimes(1);
    expect(deltas.length).toBeLessThan(chunks.length);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Ollama reports token counts only on the terminal `done: true` chunk; the
 * intermediate chunks carry none, and treating their absence as `0` would
 * report a free request.
 */
describe("createOllamaTextGenerationStream usage", () => {
  const model = {
    model_id: "ollama:test",
    provider_config: { model_name: "llama3.2" },
  } as any;
  const input = { prompt: "hi" } as any;

  function streamOf(chunks: readonly Record<string, unknown>[]) {
    return {
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  async function finishEvent(chunks: readonly Record<string, unknown>[]) {
    const getClient = vi.fn().mockResolvedValue({
      chat: vi.fn().mockResolvedValue(streamOf(chunks)),
    });
    const events: any[] = [];
    await createOllamaTextGenerationStream(getClient)(
      input,
      model,
      new AbortController().signal,
      (e: any) => events.push(e)
    );
    return events.at(-1);
  }

  it("maps the done chunk's prompt/eval counts onto finish", async () => {
    const finish = await finishEvent([
      { message: { content: "Hel" } },
      { message: { content: "lo" } },
      { message: { content: "" }, done: true, prompt_eval_count: 34, eval_count: 8 },
    ]);

    expect(finish.type).toBe("finish");
    expect(finish.usage).toEqual({
      input: 34,
      output: 8,
      // Ollama runs locally and reports no cache, reasoning or total counters.
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    });
  });

  it("leaves usage absent when the stream never reaches a done chunk", async () => {
    const finish = await finishEvent([{ message: { content: "hi" } }]);
    expect(finish.usage).toBeUndefined();
  });

  it("ignores counts on non-terminal chunks", async () => {
    const finish = await finishEvent([
      { message: { content: "hi" }, done: false, prompt_eval_count: 999, eval_count: 999 },
      { message: { content: "" }, done: true, prompt_eval_count: 12, eval_count: 3 },
    ]);
    expect(finish.usage.input).toBe(12);
    expect(finish.usage.output).toBe(3);
  });
});

describe("createOllamaTextGenerationStream chat history", () => {
  const model = {
    model_id: "ollama:test",
    provider_config: { model_name: "llava" },
  } as any;

  it("sends block history as Ollama messages: string content, images beside it, unknown blocks dropped", async () => {
    const chat = vi.fn().mockResolvedValue(makeFakeStream(["ok"]));
    const streamFn = createOllamaTextGenerationStream(vi.fn().mockResolvedValue({ chat }));
    await streamFn(
      {
        prompt: "",
        systemPrompt: "be brief",
        messages: [
          { role: "system", content: [{ type: "text", text: "answer in English" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", mimeType: "image/png", data: "AAAA" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "It looks red." },
              { type: "text", text: "A red square." },
            ],
          },
          { role: "user", content: "Thanks" },
        ],
      } as any,
      model,
      new AbortController().signal,
      () => {}
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0].messages).toEqual([
      { role: "system", content: "be brief\n\nanswer in English" },
      { role: "user", content: "What is this?", images: ["AAAA"] },
      { role: "assistant", content: "A red square." },
      { role: "user", content: "Thanks" },
    ]);
  });
});
