/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage, ModelRecord } from "@workglow/ai";
import { GEMINI_FALLBACK_MODELS, _testOnly } from "@workglow/google-gemini/ai";
import { describe, expect, it } from "vitest";

const { GoogleGeminiQueuedProvider, GEMINI_RUN_FN_SPECS, GEMINI_RUN_FNS } = _testOnly;

function model(model_id: string, capabilities: readonly string[] = []): ModelRecord {
  return {
    model_id,
    title: model_id,
    description: "",
    provider: "GOOGLE_GEMINI",
    provider_config: { model_name: model_id },
    capabilities: [...capabilities],
    metadata: {},
  } as ModelRecord;
}

describe("GoogleGeminiQueuedProvider.inferCapabilities", () => {
  const provider = new GoogleGeminiQueuedProvider(GEMINI_RUN_FNS);

  it("infers full capabilities for gemini-2.5-pro (modern family)", () => {
    const caps = provider.inferCapabilities(model("gemini-2.5-pro"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("tool-use");
    expect(caps).toContain("json-mode");
    expect(caps).toContain("vision-input");
    expect(caps).toContain("model.count-tokens");
    expect(caps).toContain("text.rewriter");
    expect(caps).toContain("text.summary");
  });

  it("infers full capabilities for gemini-1.5-flash (modern family)", () => {
    const caps = provider.inferCapabilities(model("gemini-1.5-flash"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("tool-use");
    expect(caps).toContain("vision-input");
    expect(caps).toContain("model.count-tokens");
  });

  it("infers full capabilities for gemini-3-flash-preview (3.x family)", () => {
    const caps = provider.inferCapabilities(model("gemini-3-flash-preview"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("vision-input");
    expect(caps).toContain("tool-use");
  });

  it("infers full capabilities for gemini-3.1-pro-preview (3.x family)", () => {
    const caps = provider.inferCapabilities(model("gemini-3.1-pro-preview"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("vision-input");
    expect(caps).toContain("tool-use");
  });

  it("infers text.embedding for gemini-embedding-001", () => {
    const caps = provider.inferCapabilities(model("gemini-embedding-001"));
    expect(caps).toContain("text.embedding");
    expect(caps).not.toContain("text.generation");
    expect(caps).not.toContain("vision-input");
  });

  it("infers text.embedding for text-embedding-004", () => {
    const caps = provider.inferCapabilities(model("text-embedding-004"));
    expect(caps).toContain("text.embedding");
    expect(caps).not.toContain("text.generation");
  });

  it("infers image.generation only for imagen-* models", () => {
    const caps = provider.inferCapabilities(model("imagen-4.0-generate-001"));
    expect(caps).toContain("image.generation");
    expect(caps).not.toContain("text.generation");
    expect(caps).not.toContain("image.editing");
  });

  it("infers image.generation + image.editing for gemini-*-image-* models", () => {
    const caps = provider.inferCapabilities(model("gemini-3.1-flash-image"));
    expect(caps).toContain("image.generation");
    expect(caps).toContain("image.editing");
    expect(caps).not.toContain("text.generation");
  });

  it("infers vision-input for gemini-pro-vision (legacy)", () => {
    const caps = provider.inferCapabilities(model("gemini-pro-vision"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("vision-input");
    expect(caps).toContain("tool-use");
  });

  it("does NOT infer vision-input for gemini-pro (legacy, no vision suffix)", () => {
    const caps = provider.inferCapabilities(model("gemini-pro"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("tool-use");
    expect(caps).not.toContain("vision-input");
  });

  it("does NOT infer vision-input for gemini-1.0-pro", () => {
    const caps = provider.inferCapabilities(model("gemini-1.0-pro"));
    expect(caps).toContain("text.generation");
    expect(caps).not.toContain("vision-input");
  });

  it("falls back to declared capabilities when model id is unknown", () => {
    const caps = provider.inferCapabilities(
      model("totally-unknown-model", ["text.classification"])
    );
    expect(caps).toEqual(["text.classification"]);
  });

  it("falls back to a baseline of meta-ops when nothing matches and nothing is declared", () => {
    const caps = provider.inferCapabilities(model("totally-unknown-model"));
    expect(caps).toContain("model.search");
    expect(caps).toContain("model.info");
    expect(caps).not.toContain("text.generation");
  });

  // Exact-set assertions — these must match precisely (sorted).
  it("infers exact capability set for gemini-2.5-pro", () => {
    const caps = provider.inferCapabilities(model("gemini-2.5-pro"));
    const sorted = [...caps].sort();
    expect(sorted).toEqual([
      "cache.checkpoint",
      "json-mode",
      "model.count-tokens",
      "model.info",
      "model.search",
      "session.dispose",
      "text.generation",
      "text.rewriter",
      "text.summary",
      "tool-use",
      "vision-input",
    ]);
  });

  it("infers exact capability set for gemini-embedding-001", () => {
    const caps = provider.inferCapabilities(model("gemini-embedding-001"));
    const sorted = [...caps].sort();
    expect(sorted).toEqual(["model.info", "model.search", "text.embedding"]);
  });

  it("infers exact capability set for imagen-4.0-generate-001", () => {
    const caps = provider.inferCapabilities(model("imagen-4.0-generate-001"));
    const sorted = [...caps].sort();
    expect(sorted).toEqual(["image.generation", "model.info", "model.search"]);
  });
});

describe("Gemini fallback-list coverage", () => {
  // Every model the provider lists in the fallback search results MUST get more
  // than the baseline meta-ops from the heuristic. A regex gap that misses a
  // shipping model causes silent miscapability.
  const provider = new GoogleGeminiQueuedProvider(GEMINI_RUN_FNS);

  for (const entry of GEMINI_FALLBACK_MODELS) {
    it(`infers non-baseline capabilities for fallback model ${entry.value}`, () => {
      const caps = provider.inferCapabilities(model(entry.value));
      const meaningful = caps.filter((c) => c !== "model.search" && c !== "model.info");
      expect(meaningful.length).toBeGreaterThan(0);
    });
  }
});

describe("capability-set parity", () => {
  it("GEMINI_RUN_FN_SPECS matches GEMINI_RUN_FNS serves shapes", () => {
    const fnsServes = GEMINI_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    const specsServes = GEMINI_RUN_FN_SPECS.map((s) => [...s.serves].sort().join(","));
    expect(specsServes).toEqual(fnsServes);
  });
});

describe("GEMINI_RUN_FNS shape", () => {
  it("registers a runFn for every canonical capability set", () => {
    const sets = GEMINI_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    expect(sets).toContain("text.generation");
    expect(sets).toContain("text.generation,tool-use");
    expect(sets).toContain("json-mode,text.generation");
    expect(sets).toContain("text.rewriter");
    expect(sets).toContain("text.summary");
    expect(sets).toContain("text.embedding");
    expect(sets).toContain("image.generation");
    expect(sets).toContain("image.editing");
    expect(sets).toContain("model.count-tokens");
    expect(sets).toContain("model.search");
    expect(sets).toContain("model.info");
  });

  it("tiebreaks `text.generation` to the smallest serves entry (plain text-gen)", () => {
    const candidates = GEMINI_RUN_FNS.filter((r) => r.serves.includes("text.generation"));
    expect(candidates.some((r) => r.serves.length === 1)).toBe(true);
  });
});

describe("buildGeminiContents multi-turn", () => {
  const { buildGeminiContents } = _testOnly;

  // Helper: pull every functionResponse name out of the built contents, in order.
  function functionResponseNames(contents: any[]): string[] {
    const names: string[] = [];
    for (const c of contents) {
      for (const part of c.parts ?? []) {
        if (part.functionResponse) names.push(part.functionResponse.name);
      }
    }
    return names;
  }

  it("resolves each tool_result to the tool_use it answers even when ids collide across turns", () => {
    // The provider assigns tool-call ids per run starting at `call_0`, so two
    // separate turns can each carry a tool_use with id `call_0`. Each turn's
    // functionResponse must still get its own turn's function name.
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_0", name: "get_weather", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_0",
            content: [{ type: "text", text: '{"temp":22}' }],
            is_error: undefined,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "and the time?" },
          { type: "tool_use", id: "call_0", name: "get_time", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_0",
            content: [{ type: "text", text: '{"time":"noon"}' }],
            is_error: undefined,
          },
        ],
      },
    ];

    const contents = buildGeminiContents(messages, "");
    // Turn 1's response must map to get_weather, turn 2's to get_time — a global
    // last-write-wins map would mislabel the first as get_time.
    expect(functionResponseNames(contents)).toEqual(["get_weather", "get_time"]);
  });

  it("replays the tool_use providerSignature as thoughtSignature on the functionCall part", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_0",
            name: "get_weather",
            input: { city: "Tokyo" },
            providerSignature: "sig-abc",
          },
        ],
      },
    ];

    const contents = buildGeminiContents(messages, "");
    const modelTurn = contents.find((c) => c.role === "model");
    const fnPart = modelTurn.parts.find((p: any) => p.functionCall);
    expect(fnPart.functionCall.name).toBe("get_weather");
    expect(fnPart.thoughtSignature).toBe("sig-abc");
  });

  it("omits thoughtSignature when the tool_use has no providerSignature", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_0", name: "get_weather", input: {} }],
      },
    ];

    const contents = buildGeminiContents(messages, "");
    const modelTurn = contents.find((c) => c.role === "model");
    const fnPart = modelTurn.parts.find((p: any) => p.functionCall);
    expect("thoughtSignature" in fnPart).toBe(false);
  });
});

describe("buildGeminiContents tool results", () => {
  const { buildGeminiContents } = _testOnly;

  const call = (id: string, name: string) => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  });
  const result = (id: string, content: any[], is_error?: boolean) => ({
    role: "tool",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content,
        ...(is_error ? { is_error } : {}),
      },
    ],
  });

  it.each([
    ["42", { result: 42 }],
    ["null", { result: null }],
    ["[1,2]", { result: [1, 2] }],
    ['"s"', { result: "s" }],
    ['{"a":1}', { a: 1 }],
    ["plain words", { result: "plain words" }],
  ])("wraps a %s tool result as an object", (text, response) => {
    const contents = buildGeminiContents(
      [call("c1", "t"), result("c1", [{ type: "text", text }])] as any,
      "x"
    );
    expect(contents.at(-1).parts[0].functionResponse.response).toEqual(response);
  });

  it("reports an error result under `error`", () => {
    const contents = buildGeminiContents(
      [call("c1", "t"), result("c1", [{ type: "text", text: "boom" }], true)] as any,
      "x"
    );
    expect(contents.at(-1).parts[0].functionResponse.response).toEqual({ error: "boom" });
  });

  it("returns images in functionResponse.parts", () => {
    const contents = buildGeminiContents(
      [
        call("c1", "t"),
        result("c1", [
          { type: "text", text: "here" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ]),
      ] as any,
      "x"
    );
    expect(contents.at(-1).parts[0].functionResponse).toEqual({
      name: "t",
      response: { result: "here" },
      parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }],
    });
  });
});
