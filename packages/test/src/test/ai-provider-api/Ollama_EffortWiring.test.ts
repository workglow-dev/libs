/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/ollama/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Request bodies the Ollama SDK put on the wire, one per `/api/chat` call. */
const sent: Record<string, unknown>[] = [];

function fakeOllamaFetch(_url: unknown, init?: { body?: unknown }): Promise<Response> {
  sent.push(JSON.parse(String(init?.body)));
  const line = JSON.stringify({ message: { role: "assistant", content: "{}" }, done: true });
  return Promise.resolve(
    new Response(`${line}\n`, { status: 200, headers: { "Content-Type": "application/x-ndjson" } })
  );
}

/** Capabilities whose run-fn asks the model for text, and so takes the effort dial. */
const GENERATIVE = new Set(["text.generation", "text.rewriter", "text.summary"]);

const generative = _testOnly.OLLAMA_RUN_FNS.filter((r) => r.serves.some((c) => GENERATIVE.has(c)));

const input = {
  prompt: "hi",
  text: "some text",
  tools: [],
  outputSchema: { type: "object", properties: {} },
} as any;

const qwen = (effort?: string): any => ({
  model_id: "ollama:qwen3",
  provider: "OLLAMA",
  provider_config: { model_name: "qwen3:8b" },
  ...(effort === undefined ? {} : { effort }),
});

describe("Ollama effort reaches every generative run-fn", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("fetch", fakeOllamaFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("covers every generative registration", () => {
    expect(generative.map((r) => [...r.serves].sort().join(",")).sort()).toEqual(
      expect.arrayContaining([
        "json-mode,text.generation",
        "text.generation",
        "text.generation,tool-use",
        "text.rewriter",
        "text.summary",
      ])
    );
  });

  it.each(generative.map((r) => [[...r.serves].join(","), r.runFn] as const))(
    "%s sends think for a set effort and nothing when unset",
    async (_serves, runFn) => {
      const signal = new AbortController().signal;
      await runFn(input, qwen("high"), signal, () => {}, undefined, undefined);
      await runFn(input, qwen("none"), signal, () => {}, undefined, undefined);
      await runFn(input, qwen(), signal, () => {}, undefined, undefined);
      expect(sent.map((params) => params.think)).toEqual([true, false, undefined]);
      expect("think" in sent[2]!).toBe(false);
    }
  );
});
