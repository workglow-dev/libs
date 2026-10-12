/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  llamaCppEffortPolicy,
  llamaCppThoughtBudget,
  llamaCppThoughtBudgetOption,
} from "../../../../../providers/node-llama-cpp/src/ai/common/LlamaCpp_EffortPolicy";
import {
  convertMessagesToChatHistory,
  messagesToPureChatHistoryForPrefix,
  routeLlamaResponseChunk,
} from "../../../../../providers/node-llama-cpp/src/ai/common/LlamaCpp_ToolCalling";

const IMAGE_MARKER = "[image/png image returned; this model reads text only]";

describe("convertMessagesToChatHistory", () => {
  it("replays a reasoning block as an ended thought segment ahead of the calls", () => {
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "let me call it" },
            { type: "tool_use", id: "c1", name: "shot", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
            },
          ],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response[0]).toEqual({
      type: "segment",
      segmentType: "thought",
      text: "let me call it",
      ended: true,
    });
    expect(history[1].response[1].result).toBe(IMAGE_MARKER);
    expect(history[1].response[1].result).not.toContain("AAAA");
  });

  it("skips a reasoning block with no text", () => {
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "" },
            { type: "text", text: "hello" },
          ],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response).toEqual(["hello"]);
  });

  it("keeps the text of a mixed result and puts the image marker on its own line", () => {
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "captured" },
                { type: "image", mimeType: "image/png", data: "AAAA" },
              ],
            },
          ],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response[0].result).toBe(`captured\n${IMAGE_MARKER}`);
  });

  it("keeps each block of a result in the place it held", () => {
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "before" },
                { type: "image", mimeType: "image/png", data: "AAAA" },
                { type: "text", text: "after" },
              ],
            },
          ],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response[0].result).toBe(`before\n${IMAGE_MARKER}\nafter`);
  });

  it("leaves an empty result empty instead of serializing the blocks", () => {
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "noop", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "c1", content: [] }],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response[0].result).toBe("");
  });

  it("keeps a non-text block a tool returned, as JSON", () => {
    const nested = { type: "tool_use", id: "x", name: "inner", input: { a: 1 } };
    const history = convertMessagesToChatHistory(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "noop", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "c1", content: [nested] }],
        },
      ] as any,
      undefined,
      undefined
    );
    expect(history[1].response[0].result).toBe(JSON.stringify(nested));
  });

  it("renders the same thought segment for a checkpoint prefix", () => {
    const history = messagesToPureChatHistoryForPrefix(
      [{ role: "assistant", content: [{ type: "reasoning", text: "thinking" }] }] as any,
      undefined
    );
    expect(history[0].response[0]).toMatchObject({ type: "segment", segmentType: "thought" });
  });
});

describe("routeLlamaResponseChunk", () => {
  it("routes a thought segment to the reasoning port", () => {
    expect(
      routeLlamaResponseChunk({ type: "segment", segmentType: "thought", text: "hm" })
    ).toEqual({ port: "reasoning", text: "hm" });
  });

  it("drops any other segment type", () => {
    expect(
      routeLlamaResponseChunk({ type: "segment", segmentType: "comment", text: "note" })
    ).toBeUndefined();
  });

  it("routes a main-response chunk to the text port, untyped or typed text", () => {
    for (const type of [undefined, "text"]) {
      expect(routeLlamaResponseChunk({ type, text: "answer" })).toEqual({
        port: "text",
        text: "answer",
      });
    }
  });
});

describe("llamaCppThoughtBudget", () => {
  const budget = (effort?: string): number | undefined =>
    llamaCppThoughtBudget(effort === undefined ? {} : ({ effort } as object));

  it("is undefined when no effort is set", () => {
    expect(budget()).toBeUndefined();
  });

  it.each([
    ["none", 0],
    ["low", 512],
    ["medium", 1024],
    ["high", 2048],
    ["extra", 4096],
    ["ultra", 8192],
  ])("maps %s to %i thought tokens", (effort, tokens) => {
    expect(budget(effort)).toBe(tokens);
  });

  it("is the prompt option text generation and chat send, empty when no effort is set", () => {
    expect(llamaCppThoughtBudgetOption({ effort: "high" } as object)).toEqual({
      budgets: { thoughtTokens: 2048 },
    });
    expect(llamaCppThoughtBudgetOption({})).toEqual({});
  });
});

describe("llamaCppEffortPolicy", () => {
  it("offers every level on any local model", () => {
    expect(
      llamaCppEffortPolicy({ provider_config: { model_path: "models/x.gguf" } }).supported
    ).toEqual(["none", "low", "medium", "high", "extra", "ultra"]);
  });
});
