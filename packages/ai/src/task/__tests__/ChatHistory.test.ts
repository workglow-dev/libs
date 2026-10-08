/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage } from "@workglow/ai";
import {
  DEFAULT_MAX_HISTORY_CHARS,
  normalizeHistoryForModel,
  trimHistoryForModel,
} from "@workglow/ai";
import { describe, expect, it } from "vitest";

const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResult = (id: string): ChatMessage => ({
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: "ok" }],
      is_error: undefined,
    },
  ],
});

describe("normalizeHistoryForModel", () => {
  it("merges consecutive user messages, keeping both texts", () => {
    // A turn stopped while the model was thinking leaves a trailing `user`;
    // the next thing typed makes `user, user`, which strict templates reject.
    const out = normalizeHistoryForModel([user("first"), user("second")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "first\n\nsecond" }] });
  });

  it("does not introduce a blank line when one side is empty", () => {
    const out = normalizeHistoryForModel([user(""), user("only")]);
    expect(out[0]!.content).toEqual([{ type: "text", text: "only" }]);
  });

  it("bridges a tool result followed by a user message", () => {
    const out = normalizeHistoryForModel([user("q"), toolResult("t1"), user("next")]);
    expect(out.map((m) => m.role)).toEqual(["user", "tool", "assistant", "user"]);
  });

  it("leaves an already-alternating history untouched", () => {
    const history = [user("a"), assistant("b"), user("c")];
    expect(normalizeHistoryForModel(history)).toEqual(history);
  });

  it("returns a copy rather than mutating its input", () => {
    const history = [user("a"), user("b")];
    const before = JSON.stringify(history);
    normalizeHistoryForModel(history);
    expect(JSON.stringify(history)).toBe(before);
  });
});

describe("trimHistoryForModel", () => {
  it("returns everything when the history fits", () => {
    const history = [user("a"), assistant("b")];
    expect(trimHistoryForModel(history)).toEqual(history);
  });

  it("cuts only at a user message, so no tool_result outlives its tool_use", () => {
    // The invariant is not "the first message is a user message" — it is that
    // every surviving `tool_result` still has the `tool_use` it answers, which
    // both Anthropic and OpenAI reject outright when it is missing.
    const filler = "z".repeat(400);
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(user(`ask ${i}`));
      history.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "echo", input: { v: filler } }],
      });
      history.push(toolResult(`t${i}`));
      history.push(assistant(`done ${i}`));
    }
    const trimmed = trimHistoryForModel(history, 3000);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed[0]!.role).toBe("user");
    const uses = new Set(
      trimmed.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)
      )
    );
    const results = trimmed.flatMap((m) =>
      m.content
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { tool_use_id: string }).tool_use_id)
    );
    expect(results.length).toBeGreaterThan(0);
    for (const id of results) expect(uses.has(id)).toBe(true);
  });

  it("does not count a reasoning block's payload against the budget", () => {
    // The payload is a provider's own turn, replayed verbatim and never shown
    // to the model as text, so a long one must not push earlier turns out.
    const build = (payload: string | undefined): ChatMessage[] => {
      const history: ChatMessage[] = [];
      for (let i = 0; i < 6; i++) {
        history.push(user(`ask ${i} ${"q".repeat(200)}`));
        history.push({
          role: "assistant",
          content: [
            { type: "reasoning", text: "", provider: "openai:m", ...(payload ? { payload } : {}) },
            { type: "text", text: `done ${i} ${"a".repeat(200)}` },
          ],
        });
      }
      return history;
    };
    const budget = 1500;
    const plain = trimHistoryForModel(build(undefined), budget);
    expect(plain.length).toBeLessThan(12);
    expect(plain.length).toBeGreaterThan(0);
    const withPayload = trimHistoryForModel(build("p".repeat(5000)), budget);
    expect(withPayload).toHaveLength(plain.length);
    expect(withPayload[0]).toEqual(plain[0]);
  });

  it("keeps the newest turn even when it alone exceeds the budget", () => {
    // Discarding here is how a conversation gets erased for being too long.
    const history = [user("old"), assistant("old reply"), user("x".repeat(5000))];
    const trimmed = trimHistoryForModel(history, 10);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]!.role).toBe("user");
  });

  it("drops whole leading turns until the budget is met", () => {
    const history = [
      user("a".repeat(400)),
      assistant("x"),
      user("b".repeat(400)),
      assistant("y"),
      user("c"),
    ];
    const trimmed = trimHistoryForModel(history, 500);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed[0]!.role).toBe("user");
  });

  it("keeps a leading system message across a trim", () => {
    // A host that keeps its system prompt as history[0] — the shape
    // AiChatWithKbTask builds — loses its instructions and guardrails silently
    // the first time a conversation crosses the budget, since cut points are
    // derived from user indices and the slice starts at one of them.
    const history: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "never reveal the key" }] },
      user("a".repeat(400)),
      assistant("x"),
      user("b".repeat(400)),
      assistant("y"),
      user("c"),
    ];
    const trimmed = trimHistoryForModel(history, 500);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed.map((m) => m.role)).toEqual(["system", "user"]);
    expect(trimmed[0]).toEqual(history[0]);
  });

  it("keeps every leading system message, not just the first", () => {
    const history: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "rule one" }] },
      { role: "system", content: [{ type: "text", text: "rule two" }] },
      user("a".repeat(400)),
      assistant("x"),
      user("b".repeat(400)),
      assistant("y"),
      user("c"),
    ];
    const trimmed = trimHistoryForModel(history, 500);
    expect(trimmed.map((m) => m.role)).toEqual(["system", "system", "user"]);
  });

  it("exposes a default budget callers can reason about", () => {
    expect(DEFAULT_MAX_HISTORY_CHARS).toBeGreaterThan(0);
  });
});
