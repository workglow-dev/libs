/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaEffortPolicy } from "@workglow/ollama/ai";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ollamaThinkParam } from "../../../../../providers/ollama/src/ai/common/Ollama_EffortPolicy";
import { toOllamaMessages } from "../../../../../providers/ollama/src/ai/common/Ollama_Messages";
import { createOllamaToolCallingStream } from "../../../../../providers/ollama/src/ai/common/Ollama_ToolCalling";

const model = (name: string, effort?: string): any => ({
  provider: "OLLAMA",
  provider_config: { model_name: name },
  ...(effort === undefined ? {} : { effort }),
});

describe("toOllamaMessages", () => {
  it("keeps tool calls, tool names, thinking and images across a turn", () => {
    const input = {
      systemPrompt: "be brief",
      prompt: "weather?",
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "weather?" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "need the tool" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "c1", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "sunny" },
                { type: "image", mimeType: "image/png", data: "BBBB" },
              ],
            },
          ],
        },
      ],
    } as any;
    expect(toOllamaMessages(input)).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "weather?", images: ["AAAA"] },
      {
        role: "assistant",
        content: "Checking.",
        thinking: "need the tool",
        tool_calls: [{ function: { name: "weather", arguments: { city: "Paris" } } }],
      },
      { role: "tool", content: "sunny", tool_name: "weather", images: ["BBBB"] },
    ]);
  });

  it("prefers messages over prompt when both are present", () => {
    const out = toOllamaMessages({
      prompt: "first",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
      ],
    } as any);
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("uses a string prompt when there are no messages", () => {
    expect(toOllamaMessages({ systemPrompt: "s", prompt: "hi", tools: [] } as any)).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ]);
    expect(toOllamaMessages({ prompt: "hi", tools: [], messages: [] } as any)).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("joins an array prompt's text with newlines and keeps its images", () => {
    const out = toOllamaMessages({
      prompt: [
        "one",
        { type: "text", text: "two" },
        { type: "image", mimeType: "image/png", data: "IMG" },
      ],
      tools: [],
    } as any);
    expect(out).toEqual([{ role: "user", content: "one\ntwo", images: ["IMG"] }]);
  });

  it("gives an assistant turn holding only a tool call empty content", () => {
    const out = toOllamaMessages({
      prompt: "x",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] },
      ],
    } as any);
    expect(out[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "t", arguments: {} } }],
    });
  });

  it("omits tool_name for a result whose call id is unknown", () => {
    const out = toOllamaMessages({
      prompt: "x",
      tools: [],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "missing",
              content: [{ type: "text", text: "r" }],
            },
          ],
        },
      ],
    } as any);
    expect(out).toEqual([{ role: "tool", content: "r" }]);
  });

  it("prefixes an error result's content with Error:", () => {
    const out = toOllamaMessages({
      prompt: "x",
      tools: [],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              is_error: true,
              content: [{ type: "text", text: "boom" }],
            },
          ],
        },
      ],
    } as any);
    expect(out[1]).toEqual({ role: "tool", content: "Error: boom", tool_name: "t" });
  });

  it("resolves a repeated call id against the most recent preceding call", () => {
    const result = (text: string): any => ({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "call_0", content: [{ type: "text", text }] }],
    });
    const out = toOllamaMessages({
      prompt: "x",
      tools: [],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_0", name: "a", input: {} }] },
        result("ra"),
        { role: "assistant", content: [{ type: "tool_use", id: "call_0", name: "b", input: {} }] },
        result("rb"),
      ],
    } as any);
    expect(out.filter((m) => m.role === "tool").map((m) => m.tool_name)).toEqual(["a", "b"]);
  });

  it("skips system messages in the history", () => {
    const out = toOllamaMessages({
      systemPrompt: "from input",
      prompt: "x",
      tools: [],
      messages: [
        { role: "system", content: [{ type: "text", text: "from history" }] },
        { role: "user", content: [{ type: "text", text: "x" }] },
      ],
    } as any);
    expect(out).toEqual([
      { role: "system", content: "from input" },
      { role: "user", content: "x" },
    ]);
  });
});

describe("ollamaThinkParam", () => {
  it("maps gpt-oss effort onto low/medium/high", () => {
    expect(ollamaThinkParam(model("gpt-oss:20b", "high"))).toEqual({ think: "high" });
    expect(ollamaThinkParam(model("gpt-oss:20b", "low"))).toEqual({ think: "low" });
    expect(ollamaThinkParam(model("gpt-oss:20b", "medium"))).toEqual({ think: "medium" });
    expect(ollamaThinkParam(model("gpt-oss:20b", "extra"))).toEqual({ think: "high" });
    expect(ollamaThinkParam(model("gpt-oss:20b", "ultra"))).toEqual({ think: "high" });
  });

  it("sends nothing for gpt-oss at effort none, which its policy does not list", () => {
    expect(ollamaEffortPolicy(model("gpt-oss:20b")).supported).not.toContain("none");
    expect(ollamaThinkParam(model("gpt-oss:20b", "none"))).toEqual({});
  });

  it("maps boolean-thinking families onto true/false", () => {
    expect(ollamaThinkParam(model("qwen3:8b", "none"))).toEqual({ think: false });
    expect(ollamaThinkParam(model("qwen3:8b", "medium"))).toEqual({ think: true });
    expect(ollamaThinkParam(model("deepseek-r1:7b", "high"))).toEqual({ think: true });
  });

  it("sends nothing for a model that cannot think, or when no effort is set", () => {
    expect(ollamaThinkParam(model("llama3.2", "high"))).toEqual({});
    expect(ollamaThinkParam(model("qwen3:8b"))).toEqual({});
    expect(ollamaThinkParam(undefined)).toEqual({});
  });
});

function chunks(items: unknown[]): any {
  async function* gen(): AsyncGenerator<unknown> {
    for (const item of items) yield item;
  }
  return Object.assign(gen(), { abort() {} });
}

async function runStream(m: any): Promise<{ events: any[]; request: any }> {
  let request: any;
  const chat = vi.fn(async (req: any) => {
    request = req;
    return chunks([
      { message: { thinking: "hm", content: "" } },
      { message: { content: "ok" } },
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "weather", arguments: { city: "Paris" } } }],
        },
        done: true,
      },
    ]);
  });
  const run = createOllamaToolCallingStream(async () => ({ chat }), toOllamaMessages);
  const events: any[] = [];
  await run(
    {
      prompt: "weather?",
      tools: [
        {
          name: "weather",
          description: "d",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    } as any,
    m,
    new AbortController().signal,
    (e: any) => events.push(e)
  );
  return { events, request };
}

describe("createOllamaToolCallingStream", () => {
  it("streams thinking on the reasoning port, text on text, and sends think for a thinking model", async () => {
    const { events, request } = await runStream(model("qwen3:8b", "medium"));
    expect(events).toContainEqual({ type: "text-delta", port: "reasoning", textDelta: "hm" });
    expect(events).toContainEqual({ type: "text-delta", port: "text", textDelta: "ok" });
    expect(events).toContainEqual({
      type: "object-delta",
      port: "toolCalls",
      objectDelta: [{ id: "call_0", name: "weather", input: { city: "Paris" } }],
    });
    expect(request.think).toBe(true);
    expect(request.messages).toEqual([{ role: "user", content: "weather?" }]);
  });

  it("omits think for a model that cannot think", async () => {
    const { request } = await runStream(model("llama3.2", "medium"));
    expect("think" in request).toBe(false);
  });
});

describe("browser build", () => {
  it("passes toOllamaMessages and no longer carries its own prompt-only converter", () => {
    const source = readFileSync(
      new URL(
        "../../../../../providers/ollama/src/ai/common/Ollama_JobRunFns.browser.ts",
        import.meta.url
      ),
      "utf8"
    );
    expect(source).not.toContain("buildBrowserToolCallingMessages");
    expect(source).toContain("toOllamaMessages");
  });

  it("node build no longer uses the text-flat converter", () => {
    const source = readFileSync(
      new URL("../../../../../providers/ollama/src/ai/common/Ollama_JobRunFns.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("toTextFlatMessages");
    expect(source).toContain("toOllamaMessages");
  });
});
