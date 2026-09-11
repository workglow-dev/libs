/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { classifyChatLine } from "../agent/chatCommands";
import { createChatTranscript } from "../agent/chatTranscript";

describe("classifyChatLine", () => {
  it("reads the commands it knows, in any case, around whitespace", () => {
    expect(classifyChatLine("/exit").kind).toBe("quit");
    expect(classifyChatLine("  /QUIT  ").kind).toBe("quit");
    expect(classifyChatLine("/reset").kind).toBe("reset");
    expect(classifyChatLine("/help").kind).toBe("help");
  });

  it("sends prose that merely starts with a command to the model", () => {
    // A prefix match here is a chat that silently eats a message.
    const intent = classifyChatLine("/exit is the command that ends this, right?");
    expect(intent).toEqual({
      kind: "message",
      text: "/exit is the command that ends this, right?",
    });
  });

  it("calls a lone unknown slash-word a mistyped command, not a message", () => {
    expect(classifyChatLine("/resett")).toEqual({ kind: "unknown-command", typed: "/resett" });
  });

  it("treats an empty line as nothing to send", () => {
    expect(classifyChatLine("   ").kind).toBe("blank");
  });
});

describe("createChatTranscript", () => {
  function capture() {
    const written: string[] = [];
    return { written, transcript: createChatTranscript((text) => written.push(text)) };
  }

  it("starts a note on its own line when the model stopped mid-sentence", () => {
    const { written, transcript } = capture();
    transcript.delta("Looking that up");
    transcript.note("  · FetchUrlTask");
    expect(written.join("")).toBe("Looking that up\n  · FetchUrlTask\n");
  });

  it("does not open a blank line when the model already ended one", () => {
    const { written, transcript } = capture();
    transcript.delta("Done.\n");
    transcript.note("  · one round");
    expect(written.join("")).toBe("Done.\n  · one round\n");
  });

  it("writes deltas through untouched", () => {
    const { written, transcript } = capture();
    transcript.delta("Hel");
    transcript.delta("lo");
    expect(written).toEqual(["Hel", "lo"]);
  });

  it("closes a turn onto column 0, and only when it is not already there", () => {
    const { written, transcript } = capture();
    transcript.delta("tail");
    transcript.endTurn();
    transcript.endTurn();
    expect(written.join("")).toBe("tail\n");
  });

  it("ignores an empty delta rather than counting it as content", () => {
    const { written, transcript } = capture();
    transcript.delta("x\n");
    transcript.delta("");
    transcript.note("after");
    expect(written.join("")).toBe("x\nafter\n");
  });
});
