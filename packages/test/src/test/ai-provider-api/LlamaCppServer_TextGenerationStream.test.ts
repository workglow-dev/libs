/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import { createLlamaCppServerTextGenerationStream } from "@workglow/llamacpp-server/ai-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function dataLine(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLlamaCppServerTextGenerationStream", () => {
  const model = { provider_config: { base_url: "http://localhost:8080", model_name: "m" } } as any;

  it("yields text-delta events for each delta line and a final finish", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([dataLine("Hel"), dataLine("lo"), "data: [DONE]\n"]));
    const fn = createLlamaCppServerTextGenerationStream({});

    const events: any[] = [];
    const emit = (e: any) => events.push(e);
    await fn({ prompt: "hi" } as any, model, undefined as any, emit);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(asText(url)).toBe("http://localhost:8080/v1/chat/completions");
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.textDelta)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(events[events.length - 1].type).toBe("finish");
  });

  it("uses chat messages when input.messages is non-empty", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([dataLine("ok"), "data: [DONE]\n"]));
    const fn = createLlamaCppServerTextGenerationStream({});
    const emit = (_e: any) => undefined;
    await fn(
      {
        prompt: "ignored",
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "be helpful",
      } as any,
      model,
      undefined as any,
      emit
    );
    const body = JSON.parse(asText((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts block history to chat-completions parts and drops blocks it has no form for", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([dataLine("ok"), "data: [DONE]\n"]));
    const fn = createLlamaCppServerTextGenerationStream({});
    await fn(
      {
        prompt: "",
        messages: [
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
        ],
      } as any,
      model,
      undefined as any,
      () => undefined
    );
    const body = JSON.parse(asText((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "A red square." },
    ]);
  });

  it("throws on non-2xx with informative message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const fn = createLlamaCppServerTextGenerationStream({});
    const emit = (_e: any) => undefined;
    await expect(fn({ prompt: "x" } as any, model, undefined as any, emit)).rejects.toThrow(
      /HTTP 500/
    );
  });

  it("aborts pending fetch when signal aborts before request", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([dataLine("ok"), "data: [DONE]\n"])
    );
    const fn = createLlamaCppServerTextGenerationStream({});
    const emit = (_e: any) => undefined;
    await expect(fn({ prompt: "x" } as any, model, controller.signal, emit)).rejects.toThrow();
  });

  /**
   * The usage frame carries an EMPTY `choices` array. The SSE parser used to
   * admit a chunk only when it had a content delta, tool calls, or a finish
   * reason — so a usage-only frame was dropped before any caller could see it.
   */
  describe("usage from the terminal include_usage frame", () => {
    function usageLine(usage: Record<string, unknown>): string {
      return `data: ${JSON.stringify({ choices: [], usage })}\n`;
    }

    it("requests usage and maps the usage-only frame onto finish", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          sseResponse([
            dataLine("Hel"),
            dataLine("lo"),
            usageLine({ prompt_tokens: 26, completion_tokens: 5, total_tokens: 31 }),
            "data: [DONE]\n",
          ])
        );
      const fn = createLlamaCppServerTextGenerationStream({});

      const events: any[] = [];
      await fn({ prompt: "hi" } as any, model, undefined as any, (e: any) => events.push(e));

      const body = JSON.parse(asText((fetchSpy.mock.calls[0]![1] as RequestInit).body));
      expect(body.stream_options).toEqual({ include_usage: true });

      const finish = events.at(-1);
      expect(finish.type).toBe("finish");
      expect(finish.usage).toEqual({
        input: 26,
        output: 5,
        cached: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: 31,
        extra: undefined,
      });
      // The usage frame must not be mistaken for content.
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.textDelta)).toEqual([
        "Hel",
        "lo",
      ]);
    });

    it("leaves usage absent when the server reports none", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sseResponse([dataLine("hi"), "data: [DONE]\n"])
      );
      const fn = createLlamaCppServerTextGenerationStream({});

      const events: any[] = [];
      await fn({ prompt: "hi" } as any, model, undefined as any, (e: any) => events.push(e));

      expect(events.at(-1).usage).toBeUndefined();
    });

    it("reports counters llama.cpp omits as undefined, never 0", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sseResponse([
          dataLine("hi"),
          usageLine({ prompt_tokens: 9, completion_tokens: 2 }),
          "data: [DONE]\n",
        ])
      );
      const fn = createLlamaCppServerTextGenerationStream({});

      const events: any[] = [];
      await fn({ prompt: "hi" } as any, model, undefined as any, (e: any) => events.push(e));

      const { usage } = events.at(-1);
      expect(usage.input).toBe(9);
      expect(usage.cached).toBeUndefined();
      expect(usage.reasoning).toBeUndefined();
      expect(usage.total).toBeUndefined();
    });
  });
});
