/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { OPENAI, _testOnly } from "@workglow/openai/ai";
import { afterEach, describe, expect, it } from "vitest";

const { OPENAI_RUN_FNS, getReasoningConfig, setOpenAIClientForTests } = _testOnly;

const modelFor = (model_name: string, extra: Record<string, unknown> = {}) =>
  ({
    model_id: model_name,
    title: model_name,
    description: "",
    provider: OPENAI,
    provider_config: { model_name, api_key: "test-key" },
    capabilities: ["text.generation", "tool-use"],
    metadata: {},
    ...extra,
  }) as never;

function runFnFor(serves: string): AiProviderRunFn {
  const registration = OPENAI_RUN_FNS.find(
    (r) => [...r.serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") === serves
  );
  if (!registration) throw new Error(`no OpenAI run-fn serves ${serves}`);
  return registration.runFn as AiProviderRunFn;
}

/** A finished Responses body: a reasoning summary, the answer text and one function call. */
const FINISHED_RESPONSE = {
  id: "resp_1",
  status: "completed",
  output: [
    { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Thinking." }] },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here is the answer." }],
    },
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"q":"x"}',
    },
  ],
  usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
};

function fakeClient(sent: Record<string, unknown>[]): unknown {
  return {
    responses: {
      create: async (params: Record<string, unknown>) => {
        sent.push(params);
        if (params.stream === true) throw new Error("this model does not stream");
        return FINISHED_RESPONSE;
      },
    },
  };
}

afterEach(() => setOpenAIClientForTests(undefined));

describe("a Responses model that does not stream (gpt-5.5-pro)", () => {
  it("is sent one ordinary request, and its reply arrives as text, tool calls and usage", async () => {
    const sent: Record<string, unknown>[] = [];
    setOpenAIClientForTests(fakeClient(sent));
    const events: any[] = [];
    await runFnFor("text.generation,tool-use")(
      {
        prompt: "go",
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      } as never,
      modelFor("gpt-5.5-pro"),
      new AbortController().signal,
      (e: unknown) => events.push(e)
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.stream).toBe(false);
    const text = events
      .filter((e) => e.type === "text-delta" && e.port === "text")
      .map((e) => e.textDelta)
      .join("");
    expect(text).toBe("Here is the answer.");
    const calls = events.filter((e) => e.type === "object-delta" && e.port === "toolCalls");
    expect(calls.at(-1)?.objectDelta).toEqual([
      { id: "call_1", name: "lookup", input: { q: "x" } },
    ]);
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.usage?.input).toBe(12);
  });

  it("still streams every model that can", async () => {
    const sent: Record<string, unknown>[] = [];
    setOpenAIClientForTests({
      responses: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return (async function* () {
            yield { type: "response.output_text.delta", delta: "ok" };
            yield { type: "response.completed", response: { usage: {} } };
          })();
        },
      },
    });
    await runFnFor("text.generation,tool-use")(
      { prompt: "go", tools: [] } as never,
      modelFor("gpt-5.4-pro"),
      new AbortController().signal,
      () => {}
    );
    expect(sent[0]!.stream).toBe(true);
  });
});

describe("the pro models' reasoning effort", () => {
  it.each(["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.2-pro"])(
    "%s takes medium, high and xhigh, and drops every other level",
    (name) => {
      expect(getReasoningConfig(modelFor(name, { effort: "medium" }))).toEqual({
        effort: "medium",
      });
      expect(getReasoningConfig(modelFor(name, { effort: "high" }))).toEqual({ effort: "high" });
      expect(getReasoningConfig(modelFor(name, { effort: "extra" }))).toEqual({ effort: "xhigh" });
      for (const effort of ["none", "low", "ultra"]) {
        expect(getReasoningConfig(modelFor(name, { effort }))).toBeUndefined();
      }
    }
  );
});
