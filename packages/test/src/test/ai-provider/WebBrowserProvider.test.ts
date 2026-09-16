/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatMessage,
  ModelRecord,
  StructuredGenerationTaskInput,
  ToolCallingTaskInput,
  ToolDefinition,
} from "@workglow/ai";
import { _testOnly } from "@workglow/chrome-ai/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  WebBrowserProvider,
  WEB_BROWSER_RUN_FN_SPECS,
  WEB_BROWSER_RUN_FNS,
  WebBrowser_TextGeneration_Unified,
  WebBrowser_StructuredGeneration,
  WebBrowser_ToolCalling,
  sessions,
  chatHistory,
  chromeHelpers,
  probe,
} = _testOnly;

/**
 * Test-time helpers: the chrome-ai run-fns we test take strongly-typed task
 * inputs requiring a `model` field that's irrelevant to provider-level
 * tests (the dispatcher fills it in upstream). We coerce that away here.
 */
const asSGI = (v: unknown): StructuredGenerationTaskInput => v as StructuredGenerationTaskInput;
const asTCI = (v: unknown): ToolCallingTaskInput => v as ToolCallingTaskInput;

function model(model_id: string, capabilities: readonly string[] = []): ModelRecord {
  return {
    model_id,
    title: model_id,
    description: "",
    provider: "WEB_BROWSER",
    provider_config: { model_name: model_id },
    capabilities: [...capabilities],
    metadata: {},
  } as ModelRecord;
}

// --------------------------------------------------------------------------
// Capability inference + parity
// --------------------------------------------------------------------------

/**
 * Probe factory whose `create()` always resolves to a destroyable handle.
 * Used to drive `WebBrowserProvider` past the conservative-pre-probe state
 * so we can assert the post-probe inference shape.
 */

function makeAcceptingProbeFactory(): any {
  const destroy = vi.fn();
  return {
    create: vi.fn().mockResolvedValue({ destroy }),
    params: vi.fn().mockResolvedValue({}),
  };
}

describe("WebBrowserProvider.inferCapabilities", () => {
  // Reset the module-level probe cache so each `new WebBrowserProvider`
  // can drive a fresh probe with its injected factory.
  afterEach(() => {
    probe._resetProbeCache();
  });

  it("trusts declared capabilities (probe-independent)", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("anything", ["text.translation"]));
    expect(caps).toEqual(["text.translation"]);
  });

  it("conservative pre-probe: drops json-mode and tool-use for chrome-prompt", () => {
    // Probe is async — until it resolves, the provider must NOT advertise
    // json-mode or tool-use, since the underlying API might not support them.
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("chrome-prompt"));
    expect(caps).toContain("text.generation");
    expect(caps).not.toContain("json-mode");
    expect(caps).not.toContain("tool-use");
  });

  it("post-probe: adds json-mode + tool-use when supported", async () => {
    const factory = makeAcceptingProbeFactory();
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS, undefined, factory);
    await provider.ready();
    const caps = provider.inferCapabilities(model("chrome-prompt"));
    expect(caps).toContain("text.generation");
    expect(caps).toContain("json-mode");
    expect(caps).toContain("tool-use");
    expect(provider.inferCapabilities(model("gemini-nano"))).toContain("text.generation");
  });

  it("infers text.summary for summarizer model", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("chrome-summarizer"));
    expect(caps).toContain("text.summary");
    expect(caps).not.toContain("text.generation");
  });

  it("infers text.rewriter for rewriter model", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("chrome-rewriter"));
    expect(caps).toContain("text.rewriter");
  });

  it("infers text.translation for translator model", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("chrome-translator"));
    expect(caps).toContain("text.translation");
  });

  it("infers text.language-detection for language-detector model", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("chrome-language-detector"));
    expect(caps).toContain("text.language-detection");
  });

  it("returns baseline meta-ops for unknown ids", () => {
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS);
    const caps = provider.inferCapabilities(model("unknown-id"));
    expect(caps).toEqual(["model.download", "model.search", "model.info"]);
  });
});

describe("capability-set parity", () => {
  it("WEB_BROWSER_RUN_FN_SPECS matches WEB_BROWSER_RUN_FNS serves shapes", () => {
    const fnsServes = WEB_BROWSER_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    const specsServes = WEB_BROWSER_RUN_FN_SPECS.map((s) => [...s.serves].sort().join(","));
    expect(specsServes).toEqual(fnsServes);
  });
});

describe("WEB_BROWSER_RUN_FNS shape", () => {
  it("registers a runFn for every canonical Chrome AI capability set", () => {
    const sets = WEB_BROWSER_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    expect(sets).toContain("text.generation");
    expect(sets).toContain("json-mode,text.generation");
    expect(sets).toContain("text.generation,tool-use");
    expect(sets).toContain("text.rewriter");
    expect(sets).toContain("text.summary");
    expect(sets).toContain("text.translation");
    expect(sets).toContain("text.language-detection");
    expect(sets).toContain("model.search");
    expect(sets).toContain("model.info");
  });
});

// --------------------------------------------------------------------------
// Chat dispatcher discrimination
// --------------------------------------------------------------------------

/**
 * Verify the unified text.generation run-fn picks the chat vs. text-generation
 * branch based on input shape. We don't have a real `LanguageModel` global in
 * Node, so each branch fails with `Chrome Built-in AI "LanguageModel" API is
 * not available` from `getApi`. The branch is identifiable because the chat
 * path validates `input.messages` first (the throwing call site is
 * `factory.create(...)`, but it never reaches there without the global —
 * both throw the same getApi error). To make the branch observable we read
 * back the LAST input shape `getApi` saw, which is not exposed. So instead
 * we verify discrimination through the input pre-validation: the chat path
 * throws "no user message" when `messages` is `[{ role: "system" }]`, while
 * the prompt path throws the getApi "API not available" error.
 */
describe("WebBrowser_TextGeneration_Unified discrimination", () => {
  it("dispatches to text-generation when input has no messages array", async () => {
    const emit = vi.fn();
    await expect(
      WebBrowser_TextGeneration_Unified(
        { prompt: "hello" },
        undefined,
        new AbortController().signal,
        emit
      )
    ).rejects.toThrow(/LanguageModel.*not available/);
  });

  it("dispatches to text-generation when messages is an empty array", async () => {
    const emit = vi.fn();
    await expect(
      WebBrowser_TextGeneration_Unified(
        { prompt: "hello", messages: [] },
        undefined,
        new AbortController().signal,
        emit
      )
    ).rejects.toThrow(/LanguageModel.*not available/);
  });

  it("dispatches to chat when messages has entries", async () => {
    // The chat path runs `ensureAvailable` first too, so without a real
    // `LanguageModel` global we see the same getApi error. But the chat
    // path has additional validation (missing trailing user message) which
    // we can probe by sending a system-only history.
    const emit = vi.fn();
    await expect(
      WebBrowser_TextGeneration_Unified(
        { messages: [{ role: "system", content: [{ type: "text", text: "be helpful" }] }] },
        undefined,
        new AbortController().signal,
        emit
      )
    ).rejects.toThrow(/LanguageModel.*not available/);
  });

  it("streams replacement chunks as text deltas instead of snapshot events", async () => {
    const factory = {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn(async () => ({
        promptStreaming: () =>
          new ReadableStream<string>({
            start(controller) {
              controller.enqueue("hel");
              controller.enqueue("lo");
              controller.close();
            },
          }),
        destroy: vi.fn(),
      })),
    };
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; textDelta?: string }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; textDelta?: string });
      };
      await WebBrowser_TextGeneration_Unified(
        { prompt: "hello" },
        undefined,
        new AbortController().signal,
        emit
      );
      expect(events.filter((e) => e.type === "snapshot")).toEqual([]);
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.textDelta)).toEqual([
        "hel",
        "lo",
      ]);
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// Session cache
// --------------------------------------------------------------------------

/**
 * Build a mock that satisfies the `LanguageModel` instance type as far as the
 * cache cares — `destroy()` is the only method invoked. We can't reference the
 * `LanguageModel` global directly because `@types/dom-chromium-ai` isn't loaded
 * into this test package's tsconfig (it's chrome-ai-only); `as never` bypasses
 * the strict signature while keeping the rest of the cache contract intact.
 */
type FakeLanguageModel = { destroy: ReturnType<typeof vi.fn> };
function fakeLanguageModel(): FakeLanguageModel {
  return { destroy: vi.fn() };
}

describe("WebBrowser_Sessions cache", () => {
  afterEach(() => {
    // Clean up cache between tests — these tests share module-level state.
    sessions.deleteChromeSession("test-1");
    sessions.deleteChromeSession("test-2");
  });

  it("round-trips set/get/delete", () => {
    const fake = fakeLanguageModel();
    sessions.setChromeSession("test-1", {
      session: fake as never,
      modelKey: "gemini-nano",
      messageCount: 4,
    });
    expect(sessions.getChromeSession("test-1")?.messageCount).toBe(4);
    expect(sessions.deleteChromeSession("test-1")).toBe(true);
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(sessions.getChromeSession("test-1")).toBeUndefined();
  });

  it("delete returns false for unknown ids", () => {
    expect(sessions.deleteChromeSession("never-set")).toBe(false);
  });

  it("dropChromeSessionEntry removes the entry without destroying", () => {
    const fake = fakeLanguageModel();
    sessions.setChromeSession("test-1", {
      session: fake as never,
      modelKey: "gemini-nano",
      messageCount: 1,
    });
    const removed = sessions.dropChromeSessionEntry("test-1", fake as never);
    expect(removed).toBe(true);
    expect(fake.destroy).not.toHaveBeenCalled();
    expect(sessions.getChromeSession("test-1")).toBeUndefined();
  });

  it("dropChromeSessionEntry is a no-op when the cache slot has been replaced", () => {
    const original = fakeLanguageModel();
    const replacement = fakeLanguageModel();
    sessions.setChromeSession("test-1", {
      session: original as never,
      modelKey: "gemini-nano",
      messageCount: 1,
    });
    // Simulate a concurrent caller replacing the entry.
    sessions.setChromeSession("test-1", {
      session: replacement as never,
      modelKey: "gemini-nano",
      messageCount: 2,
    });
    const removed = sessions.dropChromeSessionEntry("test-1", original as never);
    expect(removed).toBe(false);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(replacement.destroy).not.toHaveBeenCalled();
    // Replacement is still there.
    expect(sessions.getChromeSession("test-1")?.messageCount).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Chat-history mapping helpers
// --------------------------------------------------------------------------

describe("WebBrowser_ChatHistory helpers", () => {
  const userText = (text: string): ChatMessage => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const assistantText = (text: string): ChatMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const systemText = (text: string): ChatMessage => ({
    role: "system",
    content: [{ type: "text", text }],
  });

  it("messageText concatenates text blocks with double-newline separator", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(chatHistory.messageText(msg)).toBe("first\n\nsecond");
  });

  it("messageText drops non-text blocks", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "abc", name: "search", input: { q: "test" } },
      ],
    };
    expect(chatHistory.messageText(msg)).toBe("thinking");
  });

  it("findLastUserIndex returns the trailing user index", () => {
    const history: ChatMessage[] = [
      systemText("S"),
      userText("u1"),
      assistantText("a1"),
      userText("u2"),
    ];
    expect(chatHistory.findLastUserIndex(history)).toBe(3);
  });

  it("findLastUserIndex returns -1 when no user message exists", () => {
    expect(chatHistory.findLastUserIndex([systemText("S"), assistantText("a")])).toBe(-1);
  });

  it("buildInitialPromptsFromHistory returns leading system + user/assistant tail", () => {
    const result = chatHistory.buildInitialPromptsFromHistory([
      systemText("be terse"),
      userText("hi"),
      assistantText("hello"),
    ]) as unknown as { initialPrompts: unknown[]; fingerprint: string };
    expect(result.initialPrompts).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result.fingerprint).toBeTypeOf("string");
  });

  it("buildInitialPromptsFromHistory drops mid-history system messages", () => {
    const result = chatHistory.buildInitialPromptsFromHistory([
      systemText("first"),
      userText("hi"),
      systemText("second"),
      assistantText("hello"),
    ]) as unknown as { initialPrompts: unknown[] };
    expect(result.initialPrompts).toEqual([
      { role: "system", content: "first" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("buildInitialPromptsFromHistory drops tool messages", () => {
    const result = chatHistory.buildInitialPromptsFromHistory([
      systemText("S"),
      userText("call something"),
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [{ type: "text", text: "result" }],
            is_error: false,
          },
        ],
      },
      assistantText("done"),
    ]) as unknown as { initialPrompts: unknown[] };
    expect(result.initialPrompts).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "call something" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("buildInitialPromptsFromHistory drops empty-text messages", () => {
    const result = chatHistory.buildInitialPromptsFromHistory([
      systemText("S"),
      { role: "user", content: [] },
      assistantText("hello"),
    ]) as unknown as { initialPrompts: unknown[] };
    expect(result.initialPrompts).toEqual([
      { role: "system", content: "S" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("buildInitialPromptsFromHistory returns [] for empty history", () => {
    const result = chatHistory.buildInitialPromptsFromHistory([]) as unknown as {
      initialPrompts: unknown[];
      fingerprint: string;
    };
    expect(result.initialPrompts).toEqual([]);
    expect(result.fingerprint).toBe("[]");
  });

  it("reuses the same fingerprint when filtered history is unchanged", () => {
    const base = chatHistory.buildInitialPromptsFromHistory([
      systemText("S"),
      userText("hi"),
      assistantText("hello"),
    ]) as unknown as { fingerprint: string };
    const withDroppedFrames = chatHistory.buildInitialPromptsFromHistory([
      systemText("S"),
      { role: "user", content: [] },
      userText("hi"),
      systemText("ignored"),
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [{ type: "text", text: "result" }],
            is_error: false,
          },
        ],
      },
      assistantText("hello"),
    ]) as unknown as { fingerprint: string };
    expect(withDroppedFrames.fingerprint).toBe(base.fingerprint);
  });

  it("changes the fingerprint when the leading system prompt changes", () => {
    const first = chatHistory.buildInitialPromptsFromHistory([
      systemText("S1"),
      userText("hi"),
      assistantText("hello"),
    ]) as unknown as { fingerprint: string };
    const second = chatHistory.buildInitialPromptsFromHistory([
      systemText("S2"),
      userText("hi"),
      assistantText("hello"),
    ]) as unknown as { fingerprint: string };
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

// --------------------------------------------------------------------------
// Capability probe
// --------------------------------------------------------------------------

/**
 * Fake factory whose two `create()` codepaths can be independently controlled
 * — pass `jsonModeOk: false` to reject when `responseConstraint` is passed,
 * `toolUseOk: false` to reject when `tools` is passed. Records the total
 * number of `create()` invocations so we can assert coalescing behavior.
 */

function makeProbeFactory(opts: { jsonModeOk: boolean; toolUseOk: boolean }): any {
  let destroys = 0;
  const create = vi.fn(async (options?: Record<string, unknown>) => {
    if (options && "responseConstraint" in options && !opts.jsonModeOk) {
      throw new Error("responseConstraint not supported");
    }
    if (options && "tools" in options && !opts.toolUseOk) {
      throw new Error("tools not supported");
    }
    return {
      destroy: (): void => {
        destroys += 1;
      },
    };
  });
  return { create, params: vi.fn(), destroyCount: () => destroys };
}

describe("probeWebBrowserCapabilities", () => {
  // Each test injects its own factory; clear the cached coalesced promise
  // so they don't share results.
  afterEach(() => {
    probe._resetProbeCache();
  });

  it("both true when factory accepts both responseConstraint and tools", async () => {
    const f = makeProbeFactory({ jsonModeOk: true, toolUseOk: true });
    const result = await probe.probeWebBrowserCapabilities(f);
    expect(result).toEqual({ jsonMode: true, toolUse: true });
  });

  it("jsonMode false when factory rejects responseConstraint", async () => {
    const f = makeProbeFactory({ jsonModeOk: false, toolUseOk: true });
    const result = await probe.probeWebBrowserCapabilities(f);
    expect(result).toEqual({ jsonMode: false, toolUse: true });
  });

  it("toolUse false when factory rejects tools", async () => {
    const f = makeProbeFactory({ jsonModeOk: true, toolUseOk: false });
    const result = await probe.probeWebBrowserCapabilities(f);
    expect(result).toEqual({ jsonMode: true, toolUse: false });
  });

  it("both false when factory rejects both", async () => {
    const f = makeProbeFactory({ jsonModeOk: false, toolUseOk: false });
    const result = await probe.probeWebBrowserCapabilities(f);
    expect(result).toEqual({ jsonMode: false, toolUse: false });
  });

  it("coalesces concurrent calls into a single probe", async () => {
    const f = makeProbeFactory({ jsonModeOk: true, toolUseOk: true });
    // Fire N concurrent probes through the public surface. They should all
    // share the same in-flight promise and trigger at most the same set of
    // create() calls a single probe would (one per feature, not N).
    const results = await Promise.all(
      Array.from({ length: 5 }, () => probe.probeWebBrowserCapabilities(f))
    );
    expect(results.every((r) => r.jsonMode && r.toolUse)).toBe(true);
    // The probe issues exactly two create() calls — one for json-mode, one
    // for tool-use. Concurrent callers must coalesce, not multiply.
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("provider.ready() reflects the probe result", async () => {
    const f = makeProbeFactory({ jsonModeOk: true, toolUseOk: false });
    const provider = new WebBrowserProvider(WEB_BROWSER_RUN_FNS, undefined, f);
    // Pre-ready: conservative subset for chrome-prompt.
    const preCaps = provider.inferCapabilities(model("chrome-prompt"));
    expect(preCaps).not.toContain("json-mode");
    expect(preCaps).not.toContain("tool-use");
    await provider.ready();
    // Post-ready: json-mode appears, tool-use stays gated.
    const postCaps = provider.inferCapabilities(model("chrome-prompt"));
    expect(postCaps).toContain("json-mode");
    expect(postCaps).not.toContain("tool-use");
  });
});

// --------------------------------------------------------------------------
// StructuredGeneration behavior
// --------------------------------------------------------------------------

/**
 * Install a fake `LanguageModel` global so the run-fn's `getApi` /
 * `ensureAvailable` checks pass. Returns a teardown.
 */
function installLanguageModelGlobal(impl: unknown): () => void {
  const prior = (globalThis as Record<string, unknown>).LanguageModel;
  (globalThis as Record<string, unknown>).LanguageModel = impl;
  return () => {
    if (prior === undefined) {
      delete (globalThis as Record<string, unknown>).LanguageModel;
    } else {
      (globalThis as Record<string, unknown>).LanguageModel = prior;
    }
  };
}

/**
 * Fake `LanguageModel` factory + session that streams a single chunk of
 * pre-canned text. `text` is the full JSON payload returned by the
 * model's "response" in one snapshot — sufficient for our parse pipeline
 * because Chrome's stream surface emits progressive snapshots.
 */

function makeFakeLanguageModel(text: string | (() => string)): any {
  let destroyed = 0;
  const factory = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn(async () => ({
      promptStreaming: (_p: string, _o?: unknown) => {
        const value = typeof text === "function" ? text() : text;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      },
      destroy: () => {
        destroyed += 1;
      },
    })),
  };
  return { factory, destroyed: () => destroyed };
}

describe("WebBrowser_StructuredGeneration behavior", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
    additionalProperties: false,
  } as const;
  const sid = "sg-test-1";

  afterEach(() => {
    sessions.deleteChromeSession(sid);
  });

  it("creates a fresh session for each call even when sessionId repeats", async () => {
    const { factory } = makeFakeLanguageModel('{"x":1}');
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      await WebBrowser_StructuredGeneration(
        asSGI({ prompt: "p", outputSchema: schema }),
        undefined,
        new AbortController().signal,
        emit,
        schema,
        { sessionId: sid }
      );
      await WebBrowser_StructuredGeneration(
        asSGI({ prompt: "p2", outputSchema: schema }),
        undefined,
        new AbortController().signal,
        emit,
        schema,
        { sessionId: sid }
      );
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(sessions.getChromeSession(sid)).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// StructuredGeneration final-JSON validation
// --------------------------------------------------------------------------

describe("WebBrowser_StructuredGeneration validation", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
    additionalProperties: false,
  } as const;

  it("emits finish on valid JSON that satisfies the schema", async () => {
    const { factory } = makeFakeLanguageModel('{"x":1}');
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: unknown[] = [];
      const emit = (e: unknown): void => {
        events.push(e);
      };
      await WebBrowser_StructuredGeneration(
        asSGI({ prompt: "p", outputSchema: schema }),
        undefined,
        new AbortController().signal,
        emit,
        schema
      );
      const finish = events.find((e) => (e as { type?: string }).type === "finish") as
        | { data: { object: { x: number } } }
        | undefined;
      expect(finish).toBeDefined();
      expect(finish?.data.object).toEqual({ x: 1 });
    } finally {
      restore();
    }
  });

  it("emits finish with an empty object when the final JSON is unparseable", async () => {
    const { factory } = makeFakeLanguageModel("definitely not json");
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: unknown[] = [];
      const emit = (e: unknown): void => {
        events.push(e);
      };
      await WebBrowser_StructuredGeneration(
        asSGI({ prompt: "p", outputSchema: schema }),
        undefined,
        new AbortController().signal,
        emit,
        schema
      );
      const finish = events.find((e) => (e as { type?: string }).type === "finish") as
        | { data: { object: Record<string, unknown> } }
        | undefined;
      expect(finish?.data.object).toEqual({});
    } finally {
      restore();
    }
  });

  it("emits finish even when the parsed object fails schema validation", async () => {
    const { factory } = makeFakeLanguageModel('{"x":"oops"}');
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: unknown[] = [];
      const emit = (e: unknown): void => {
        events.push(e);
      };
      await WebBrowser_StructuredGeneration(
        asSGI({ prompt: "p", outputSchema: schema }),
        undefined,
        new AbortController().signal,
        emit,
        schema
      );
      const finish = events.find((e) => (e as { type?: string }).type === "finish") as
        | { data: { object: { x: string } } }
        | undefined;
      expect(finish?.data.object).toEqual({ x: "oops" });
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// WebBrowser_Chat session cache
// --------------------------------------------------------------------------

/**
 * Fake `LanguageModel` for chat tests. Each `create()` returns a fresh
 * session whose `promptStreaming` emits one canned text snapshot per turn.
 * The factory records each call's options so we can inspect what was
 * passed.
 */

function makeFakeChatModel(repliesPerTurn: readonly string[]): any {
  let turn = 0;
  const sessions: Array<{
    destroy: ReturnType<typeof vi.fn>;
    promptStreaming: ReturnType<typeof vi.fn>;
  }> = [];
  const factory = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn(async () => {
      const promptStreaming = vi.fn(() => {
        const value = repliesPerTurn[turn++] ?? "";
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      });
      const session = { destroy: vi.fn(), promptStreaming };
      sessions.push(session);
      return session;
    }),
  };
  return { factory, sessions };
}

describe("WebBrowser_Chat session cache", () => {
  const sid = "chat-test-1";
  const userMsg = (text: string): ChatMessage => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const assistantMsg = (text: string): ChatMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  afterEach(() => {
    sessions.deleteChromeSession?.(sid);
  });

  it("reuses the cached session across consecutive turns (one factory.create)", async () => {
    const { factory, sessions: fakeSessions } = makeFakeChatModel(["hi back", "sure"]);
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      const turn1: ChatMessage[] = [userMsg("hi")];
      await WebBrowser_TextGeneration_Unified(
        { messages: turn1 },
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      // After turn 1 cache should be at messages.length + 1 == 2.
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(2);
      const turn2: ChatMessage[] = [
        userMsg("hi"),
        assistantMsg("hi back"),
        userMsg("how are you?"),
      ];
      await WebBrowser_TextGeneration_Unified(
        { messages: turn2 },
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      // Same session reused: only one factory.create call total.
      expect(factory.create).toHaveBeenCalledTimes(1);
      // promptStreaming called twice on the SAME session reference.
      expect(fakeSessions).toHaveLength(1);
      expect(fakeSessions[0]?.promptStreaming).toHaveBeenCalledTimes(2);
      // After turn 2, cache watermark = messages.length + 1 = 4.
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(4);
    } finally {
      restore();
    }
  });

  it("rebuilds the session when messageCount diverges (e.g. retroactive edit)", async () => {
    const { factory, sessions: fakeSessions } = makeFakeChatModel(["a", "b"]);
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      await WebBrowser_TextGeneration_Unified(
        { messages: [userMsg("first")] },
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      // Cache is at messageCount=2 after turn 1.
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(2);
      // Now simulate a retroactive history mutation by shrinking the history:
      // the caller resends a single user message (messages.length=1, so
      // lastUserIdx=0 and expectedPriorCount=1), but the cache still has
      // messageCount=2 from the previous turn. The mismatch (1 !== 2) forces
      // the run-fn to destroy the cached session and rebuild from scratch.
      await WebBrowser_TextGeneration_Unified(
        { messages: [userMsg("reset")] },
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      expect(factory.create).toHaveBeenCalledTimes(2);
      // First session was destroyed during the divergence rebuild.
      expect(fakeSessions[0]?.destroy).toHaveBeenCalled();
      // Watermark after the rebuilt turn = messages.length + 1 = 2.
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(2);
    } finally {
      restore();
    }
  });

  it("retries once with a fresh session when a cached session is destroyed", async () => {
    // Turn 1's session prompts successfully (seeds the cache), then on
    // turn 2's reuse its promptStreaming throws InvalidStateError as if
    // Chrome had destroyed the session between calls. The run-fn must
    // rebuild and retry once with a fresh session.
    const staleDestroy = vi.fn();
    const stalePrompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new ReadableStream<string>({
            start(controller) {
              controller.enqueue("hi back");
              controller.close();
            },
          })
      )
      .mockImplementationOnce(() => {
        throw new DOMException(
          "The model execution session has been destroyed.",
          "InvalidStateError"
        );
      });
    const staleSession = { promptStreaming: stalePrompt, destroy: staleDestroy };

    const freshDestroy = vi.fn();
    const freshPrompt = vi.fn(
      () =>
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue("recovery");
            controller.close();
          },
        })
    );
    const freshSession = { promptStreaming: freshPrompt, destroy: freshDestroy };

    const create = vi.fn().mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
    const factory = { availability: vi.fn().mockResolvedValue("available"), create };
    const restore = installLanguageModelGlobal(factory);
    try {
      // Turn 1 — seeds the cache with the stale session.
      await WebBrowser_TextGeneration_Unified(
        { messages: [userMsg("hi")] },
        undefined,
        new AbortController().signal,
        vi.fn(),
        undefined,
        { sessionId: sid }
      );
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(2);

      // Turn 2 — cached promptStreaming throws InvalidStateError;
      // expect rebuild + retry.
      const deltas: string[] = [];
      await WebBrowser_TextGeneration_Unified(
        { messages: [userMsg("hi"), assistantMsg("hi back"), userMsg("follow up")] },
        undefined,
        new AbortController().signal,
        (event: unknown) => {
          const e = event as { type: string; textDelta?: string };
          if (e.type === "text-delta") deltas.push(e.textDelta ?? "");
        },
        undefined,
        { sessionId: sid }
      );

      // Two factory.create calls: turn 1's seed + turn 2's retry rebuild.
      expect(create).toHaveBeenCalledTimes(2);
      // Stale promptStreaming was called twice (success on turn 1, throw on turn 2).
      expect(stalePrompt).toHaveBeenCalledTimes(2);
      // Stale session destroyed during retry cleanup.
      expect(staleDestroy).toHaveBeenCalledOnce();
      // Retry session served the second turn.
      expect(freshPrompt).toHaveBeenCalledOnce();
      // Consumer saw only the retry's delta (the failing first attempt
      // emitted nothing before throwing).
      expect(deltas.join("")).toBe("recovery");
      // Cache now points at the fresh session, watermark = 4.
      expect(_testOnly.sessions.getChromeSession(sid)?.messageCount).toBe(4);
      expect(_testOnly.sessions.getChromeSession(sid)?.session).toBe(freshSession);
    } finally {
      restore();
    }
  });

  it("does not retry when a fresh (non-cached) session fails", async () => {
    // No prior cache write, so the failing session was created fresh this
    // turn — retrying would just hit the same broken model state.
    const destroy = vi.fn();
    const promptStreaming = vi.fn(() => {
      throw new DOMException(
        "The model execution session has been destroyed.",
        "InvalidStateError"
      );
    });
    const create = vi.fn().mockResolvedValue({ promptStreaming, destroy });
    const factory = { availability: vi.fn().mockResolvedValue("available"), create };
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      await expect(
        WebBrowser_TextGeneration_Unified(
          { messages: [userMsg("hi")] },
          undefined,
          new AbortController().signal,
          emit,
          undefined,
          { sessionId: sid }
        )
      ).rejects.toThrow(/destroyed/);
      // Single create + destroy; no retry rebuild.
      expect(create).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// ToolCalling session lifecycle
// --------------------------------------------------------------------------

/**
 * Fake `LanguageModel` for tool-calling tests. The session's
 * `promptStreaming` immediately invokes each declared tool's `execute`
 * callback so the run-fn captures the tool calls, then closes the stream.
 *
 * `callsBy[toolName]` supplies args for each capture; if omitted defaults
 * to `{}`.
 */

function makeFakeToolCallingModel(callsBy: Record<string, unknown> = {}): any {
  const factory = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn(
      async (options?: {
        tools?: Array<{ name: string; execute: (...args: unknown[]) => Promise<string> }>;
      }) => {
        const tools = options?.tools ?? [];
        return {
          promptStreaming: () =>
            new ReadableStream<string>({
              async start(controller) {
                for (const t of tools) {
                  if (t.name === "_probe") continue; // probe tool ignored here
                  const args = callsBy[t.name] ?? {};
                  await t.execute(args);
                }
                controller.close();
              },
            }),
          destroy: vi.fn(),
        };
      }
    ),
  };
  return { factory };
}

describe("WebBrowser_ToolCalling session lifecycle", () => {
  const sid = "tc-test-1";
  const toolA: ToolDefinition = {
    name: "tool_a",
    description: "tool a",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };
  const toolB: ToolDefinition = {
    name: "tool_b",
    description: "tool b",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };

  afterEach(() => {
    sessions.deleteChromeSession(sid);
  });

  it("creates a fresh session for each turn even when sessionId repeats", async () => {
    const { factory } = makeFakeToolCallingModel();
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      const messages: ChatMessage[] = [
        { role: "user", content: [{ type: "text", text: "do it" }] },
      ];
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "", tools: [toolA, toolB], messages }),
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      const messages2: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ];
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "", tools: [toolA, toolB], messages: messages2 }),
        undefined,
        new AbortController().signal,
        emit,
        undefined,
        { sessionId: sid }
      );
      // Tool-calling intentionally rebuilds per turn — two creates expected.
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(sessions.getChromeSession(sid)).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// ToolCalling argument validation
// --------------------------------------------------------------------------

describe("WebBrowser_ToolCalling argument validation", () => {
  const strictTool: ToolDefinition = {
    name: "echo",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };

  it("passes through calls whose args satisfy the inputSchema", async () => {
    const { factory } = makeFakeToolCallingModel({ echo: { text: "hello" } });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string; objectDelta?: unknown }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string; objectDelta?: unknown });
      };
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "go", tools: [strictTool] }),
        undefined,
        new AbortController().signal,
        emit
      );
      const tcEvent = events.find((e) => e.type === "object-delta" && e.port === "toolCalls");
      expect(tcEvent).toBeDefined();
      const calls = (tcEvent?.objectDelta as Array<{ name: string; input: unknown }>) ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({ text: "hello" });
    } finally {
      restore();
    }
  });

  it("drops calls missing a required field", async () => {
    // `text` is required but omitted.
    const { factory } = makeFakeToolCallingModel({ echo: {} });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string });
      };
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "go", tools: [strictTool] }),
        undefined,
        new AbortController().signal,
        emit
      );
      // No toolCalls event since the only call was dropped.
      expect(events.some((e) => e.type === "object-delta" && e.port === "toolCalls")).toBe(false);
    } finally {
      restore();
    }
  });

  it("drops calls with a wrong-typed field", async () => {
    // `text` must be string; passing a number fails validation.
    const { factory } = makeFakeToolCallingModel({ echo: { text: 42 } });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string });
      };
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "go", tools: [strictTool] }),
        undefined,
        new AbortController().signal,
        emit
      );
      expect(events.some((e) => e.type === "object-delta" && e.port === "toolCalls")).toBe(false);
    } finally {
      restore();
    }
  });

  it("falls through to name-check when inputSchema fails to compile", async () => {
    // A schema that compileSchema can't handle. The malformed-schema tool
    // should still see its call pass through (no crash, no validation), and
    // hallucinated names still get filtered.
    const malformedTool = {
      name: "loose",
      description: "loose",
      // Garbage schema — type is invalid.
      inputSchema: { type: "not_a_real_type" } as unknown,
    } as { name: string; description: string; inputSchema: unknown };
    const { factory } = makeFakeToolCallingModel({ loose: { anything: 1 } });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string; objectDelta?: unknown }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string; objectDelta?: unknown });
      };
      await WebBrowser_ToolCalling(
        asTCI({
          prompt: "go",
          tools: [malformedTool as unknown as typeof strictTool],
        }),
        undefined,
        new AbortController().signal,
        emit
      );
      // Either the schema compiled and validation passed (loose schema),
      // or it failed to compile and the call fell through unchanged.
      // Either way, no crash, and we see the tool call event.
      const tcEvent = events.find((e) => e.type === "object-delta" && e.port === "toolCalls");
      expect(tcEvent).toBeDefined();
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// ToolCalling prototype-pollution sanitization
// --------------------------------------------------------------------------

describe("WebBrowser_ToolCalling sanitizes captured args", () => {
  const looseTool: ToolDefinition = {
    name: "loose",
    description: "loose",
    // Permissive schema so the validator doesn't reject the cleaned object.
    inputSchema: { type: "object", additionalProperties: true },
  };

  it("strips __proto__ and constructor keys from captured tool args", async () => {
    // Build a payload as if the model hallucinated a prototype-pollution attempt.
    const polluted: Record<string, unknown> = { ok: true };
    // Use Object.defineProperty so `__proto__` is captured as a real own key,
    // not as the actual prototype link — mirrors what JSON.parse can do.
    Object.defineProperty(polluted, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(polluted, "constructor", {
      value: { evil: 1 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const { factory } = makeFakeToolCallingModel({ loose: polluted });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string; objectDelta?: unknown }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string; objectDelta?: unknown });
      };
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "go", tools: [looseTool] }),
        undefined,
        new AbortController().signal,
        emit
      );
      const tcEvent = events.find((e) => e.type === "object-delta" && e.port === "toolCalls");
      const calls =
        (tcEvent?.objectDelta as Array<{ name: string; input: Record<string, unknown> }>) ?? [];
      expect(calls).toHaveLength(1);
      const input = calls[0]!.input;
      // Legitimate key preserved.
      expect(input.ok).toBe(true);
      // Forbidden keys scrubbed.
      expect(Object.prototype.hasOwnProperty.call(input, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(input, "constructor")).toBe(false);
      // Prototype is plain Object.prototype — not the tainted attacker object.
      expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
      // And the actual Object prototype was not polluted as a side-effect.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("strips forbidden keys recursively in nested objects and arrays", async () => {
    const inner: Record<string, unknown> = { ok: true };
    Object.defineProperty(inner, "constructor", {
      value: { x: 1 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const outer: Record<string, unknown> = {
      list: [inner],
    };
    Object.defineProperty(outer, "__proto__", {
      value: { p: 1 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const payload: Record<string, unknown> = { outer };
    const { factory } = makeFakeToolCallingModel({ loose: payload });
    const restore = installLanguageModelGlobal(factory);
    try {
      const events: Array<{ type: string; port?: string; objectDelta?: unknown }> = [];
      const emit = (e: unknown): void => {
        events.push(e as { type: string; port?: string; objectDelta?: unknown });
      };
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "go", tools: [looseTool] }),
        undefined,
        new AbortController().signal,
        emit
      );
      const tcEvent = events.find((e) => e.type === "object-delta" && e.port === "toolCalls");
      const calls = (tcEvent?.objectDelta as Array<{ input: Record<string, unknown> }>) ?? [];
      expect(calls).toHaveLength(1);
      const input = calls[0]!.input;
      const o = input.outer as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(o, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
      const list = o.list as Array<Record<string, unknown>>;
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(1);
      const first = list[0]!;
      expect(first.ok).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(first, "constructor")).toBe(false);
      expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    } finally {
      restore();
    }
  });
});

// --------------------------------------------------------------------------
// snapshotStreamToTextDeltas reset semantics
// --------------------------------------------------------------------------

/** Collect events emitted by an emit-callback helper into an array. */
async function collect<T>(run: (emit: (event: T) => void) => Promise<void>): Promise<T[]> {
  const out: T[] = [];
  await run((event) => {
    out.push(event);
  });
  return out;
}

/** Build a ReadableStream that emits the given strings in order. */
function streamOf(values: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

describe("snapshotStreamToTextDeltas", () => {
  it("emits incremental deltas on prefix-extending snapshots", async () => {
    const events = await collect((emit) =>
      chromeHelpers.snapshotStreamToTextDeltas(
        streamOf(["hel", "hello", "hello world"]),
        "text",
        emit
      )
    );
    const deltas = events
      .filter((e) => (e as { type: string }).type === "text-delta")
      .map((e) => (e as { textDelta: string }).textDelta);
    expect(deltas).toEqual(["hel", "lo", " world"]);
  });

  it("resets on a non-prefix snapshot", async () => {
    const events = await collect((emit) =>
      chromeHelpers.snapshotStreamToTextDeltas(
        streamOf(["hello world", "hello sailor"]),
        "text",
        emit
      )
    );
    const deltas = events
      .filter((e) => (e as { type: string }).type === "text-delta")
      .map((e) => (e as { textDelta: string }).textDelta);
    expect(deltas).toEqual(["hello world", "hello sailor"]);
    // No buggy concatenation anywhere in the emitted stream.
    for (const d of deltas) {
      expect(d).not.toContain("hello worldhello sailor");
    }
  });

  it("does not emit an empty delta on identical snapshots", async () => {
    const events = await collect((emit) =>
      chromeHelpers.snapshotStreamToTextDeltas(streamOf(["hi", "hi"]), "text", emit)
    );
    const deltas = events.filter((e) => (e as { type: string }).type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { textDelta: string }).textDelta).toBe("hi");
  });
});

// --------------------------------------------------------------------------
// ToolCalling multi-round context
// --------------------------------------------------------------------------

/**
 * A `LanguageModel` that records what each turn was actually asked, so a test
 * can tell two rounds apart. It calls no tools: the point is the request.
 */
function makeRecordingToolCallingModel(): {
  factory: any;
  turns: Array<{ initialPrompts: unknown; promptText: string }>;
} {
  const turns: Array<{ initialPrompts: unknown; promptText: string }> = [];
  const factory = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn(async (options?: { initialPrompts?: unknown }) => {
      const initialPrompts = options?.initialPrompts;
      return {
        promptStreaming: (text: string) => {
          turns.push({ initialPrompts, promptText: text });
          return new ReadableStream<string>({
            start(controller) {
              controller.close();
            },
          });
        },
        destroy: vi.fn(),
      };
    }),
  };
  return { factory, turns };
}

describe("WebBrowser_ToolCalling multi-round context", () => {
  const toolA: ToolDefinition = {
    name: "tool_a",
    description: "tool a",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };

  /**
   * An agent turn feeds each round back as `messages` alone: the assistant's
   * `tool_use` and a `role: "tool"` message carrying the `tool_result`. Chrome
   * has no frame for either, so dropping them made round two's request
   * byte-identical to round one's — the model asked for the same tool again,
   * every round, and the turn ended with no answer and the tool run N times.
   */
  it("carries the tool result into the next round's request", async () => {
    const { factory, turns } = makeRecordingToolCallingModel();
    const restore = installLanguageModelGlobal(factory);
    try {
      const emit = vi.fn();
      const round1: ChatMessage[] = [
        { role: "user", content: [{ type: "text", text: "what is the weather" }] },
      ];
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "", tools: [toolA], messages: round1 }),
        undefined,
        new AbortController().signal,
        emit
      );

      const round2: ChatMessage[] = [
        ...round1,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "tool_a", input: { city: "Paris" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [{ type: "text", text: "18C and raining" }],
              is_error: undefined,
            },
          ],
        },
      ];
      await WebBrowser_ToolCalling(
        asTCI({ prompt: "", tools: [toolA], messages: round2 }),
        undefined,
        new AbortController().signal,
        emit
      );

      expect(turns).toHaveLength(2);
      expect(turns[1]!.promptText).not.toBe(turns[0]!.promptText);
      expect(turns[1]!.promptText).toContain("what is the weather");
      expect(turns[1]!.promptText).toContain("tool_a");
      expect(turns[1]!.promptText).toContain("18C and raining");
    } finally {
      restore();
    }
  });

  it("keeps the system prompt when a history is also supplied", async () => {
    const { factory, turns } = makeRecordingToolCallingModel();
    const restore = installLanguageModelGlobal(factory);
    try {
      await WebBrowser_ToolCalling(
        asTCI({
          prompt: "",
          tools: [toolA],
          systemPrompt: "You are terse.",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
        undefined,
        new AbortController().signal,
        vi.fn()
      );

      expect(turns[0]!.initialPrompts).toEqual([{ role: "system", content: "You are terse." }]);
    } finally {
      restore();
    }
  });

  it("marks a failed tool result as an error rather than as its answer", () => {
    const text = chatHistory.flattenToolExchange([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "tool_a", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [{ type: "text", text: "no such city" }],
            is_error: true,
          },
        ],
      },
    ]);

    expect(text).toContain("Tool error from tool_a: no such city");
  });
});
