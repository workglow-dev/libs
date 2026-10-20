/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_STREAMED_TEXT,
  foldTextDelta,
  tailLines,
  visibleReasoning,
  type StreamedText,
} from "./streamedText";

const fold = (events: ReadonlyArray<Parameters<typeof foldTextDelta>[1]>): StreamedText =>
  events.reduce(foldTextDelta, EMPTY_STREAMED_TEXT);

describe("foldTextDelta", () => {
  it("keeps text and reasoning apart", () => {
    const out = fold([
      { type: "text-delta", port: "reasoning", textDelta: "Let me " },
      { type: "text-delta", port: "reasoning", textDelta: "think." },
      { type: "text-delta", port: "text", textDelta: "Hel" },
      { type: "text-delta", port: "text", textDelta: "lo" },
    ]);
    expect(out).toEqual({ text: "Hello", reasoning: "Let me think." });
  });

  it("treats a missing port as text", () => {
    expect(fold([{ type: "text-delta", textDelta: "hi" }])).toEqual({
      text: "hi",
      reasoning: "",
    });
  });

  it("reads a task's own output port as its text", () => {
    expect(
      foldTextDelta(EMPTY_STREAMED_TEXT, { type: "text-delta", port: "code", textDelta: "x" })
    ).toEqual({ text: "x", reasoning: "" });
  });

  it("ignores other event types and empty deltas, returning the same object", () => {
    const prev: StreamedText = { text: "a", reasoning: "b" };
    expect(foldTextDelta(prev, { type: "finish" })).toBe(prev);
    expect(foldTextDelta(prev, { type: "text-delta", port: "text", textDelta: "" })).toBe(prev);
    expect(foldTextDelta(prev, { type: "text-delta", port: "text" })).toBe(prev);
  });
});

describe("foldTextDelta on a text-retract", () => {
  it("takes back the tail of its own port, so the retry appends after what remains", () => {
    const out = fold([
      { type: "text-delta", port: "reasoning", textDelta: "Thinking" },
      { type: "text-delta", port: "text", textDelta: "First. " },
      { type: "text-delta", port: "text", textDelta: "Oops" },
      { type: "text-retract", port: "text", length: 4 },
      { type: "text-delta", port: "text", textDelta: "Second." },
    ]);
    expect(out).toEqual({ text: "First. Second.", reasoning: "Thinking" });
  });

  it("retracts reasoning on its own port, and clamps at the start", () => {
    const out = fold([
      { type: "text-delta", port: "reasoning", textDelta: "abc" },
      { type: "text-delta", port: "text", textDelta: "kept" },
      { type: "text-retract", port: "reasoning", length: 10 },
    ]);
    expect(out).toEqual({ text: "kept", reasoning: "" });
  });

  it("returns the same object when there is nothing to take back", () => {
    const prev: StreamedText = { text: "a", reasoning: "" };
    expect(foldTextDelta(prev, { type: "text-retract", port: "text", length: 0 })).toBe(prev);
    expect(foldTextDelta(prev, { type: "text-retract", port: "reasoning", length: 3 })).toBe(prev);
  });
});

describe("visibleReasoning", () => {
  it("shows thinking until the answer starts", () => {
    expect(visibleReasoning({ text: "", reasoning: "hmm" })).toBe("hmm");
    expect(visibleReasoning({ text: "A", reasoning: "hmm" })).toBe("");
  });
});

describe("tailLines", () => {
  it("keeps the last n lines and leaves a short text alone", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(tailLines("a\nb", 5)).toBe("a\nb");
  });
});
