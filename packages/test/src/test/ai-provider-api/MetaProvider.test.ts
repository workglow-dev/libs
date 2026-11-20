/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import type { MetaModelConfig } from "@workglow/meta/ai";
import { _testOnly, getMetaReasoningEffort, META, metaEffortPolicy } from "@workglow/meta/ai";
import { asText } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sseResponse } from "./chatCompletionsWire";

const { META_RUN_FNS, resetMetaStreamUsageSupportForTests } = _testOnly;

function cfg(model_name: string, extra?: Partial<MetaModelConfig>): MetaModelConfig {
  return {
    provider: META,
    provider_config: { model_name, api_key: "test-key" },
    ...extra,
  } as MetaModelConfig;
}

function runFnFor(serves: string): AiProviderRunFn {
  const registration = META_RUN_FNS.find(
    (r) => [...r.serves].sort((a: string, b: string) => a.localeCompare(b)).join(",") === serves
  );
  if (!registration) throw new Error(`no Meta run-fn serves ${serves}`);
  return registration.runFn as AiProviderRunFn;
}

const doneChunks = [
  { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "{}" } }] },
  {
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
];

let fetchSpy: ReturnType<typeof vi.spyOn>;

function sentBodies(): Record<string, unknown>[] {
  return fetchSpy.mock.calls.map(([, init]: [unknown, unknown]) =>
    JSON.parse(asText((init as RequestInit).body))
  );
}

async function run(
  serves: string,
  input: Record<string, unknown>,
  model: MetaModelConfig = cfg("muse-spark-1.3")
): Promise<unknown[]> {
  const events: unknown[] = [];
  await runFnFor(serves)(input as never, model, new AbortController().signal, (e: unknown) =>
    events.push(e)
  );
  return events;
}

beforeEach(() => {
  resetMetaStreamUsageSupportForTests();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => sseResponse(doneChunks));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("Meta request shaping", () => {
  it("sends to api.meta.ai and asks for streamed usage", async () => {
    await run("text.generation", { prompt: "hi" });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.meta.ai/v1/chat/completions");
    expect(sentBodies()[0]).toMatchObject({
      model: "muse-spark-1.3",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("never sends penalties, and sends temperature alone when top_p is set too", async () => {
    await run("text.generation", {
      prompt: "hi",
      temperature: 0.4,
      topP: 0.9,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
    });
    const body = sentBodies()[0]!;
    expect(body.temperature).toBe(0.4);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
  });

  it("sends top_p when it is the only sampling setting", async () => {
    await run("text.generation", { prompt: "hi", topP: 0.9 });
    expect(sentBodies()[0]!.top_p).toBe(0.9);
    expect(sentBodies()[0]).not.toHaveProperty("temperature");
  });

  it("resends without stream_options when the server refuses it, then stops asking", async () => {
    let first = true;
    fetchSpy.mockImplementation(async () => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: stream_options",
              type: "invalid_request_error",
              param: "stream_options",
              code: "unsupported_parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return sseResponse(doneChunks);
    });
    await run("text.generation", { prompt: "hi" });
    await run("text.generation", { prompt: "again" });
    const bodies = sentBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty("stream_options");
    expect(bodies[1]).not.toHaveProperty("stream_options");
    expect(bodies[2]).not.toHaveProperty("stream_options");
  });

  it("does not retry a 400 about some other parameter", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "bad temperature", param: "temperature" } }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
    );
    await expect(run("text.generation", { prompt: "hi" })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Meta tool choice", () => {
  const tools = [
    {
      name: "lookup",
      description: "Look something up",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ];

  it("sends tools and leaves tool_choice to Meta's default for auto", async () => {
    await run("text.generation,tool-use", { prompt: "hi", tools, toolChoice: "auto" });
    const body = sentBodies()[0]!;
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("honors none by sending no tools", async () => {
    await run("text.generation,tool-use", { prompt: "hi", tools, toolChoice: "none" });
    const body = sentBodies()[0]!;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it.each(["required", "lookup"])("refuses %s before reaching the API", async (toolChoice) => {
    await expect(
      run("text.generation,tool-use", { prompt: "hi", tools, toolChoice })
    ).rejects.toThrow(/only toolChoice "auto"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Meta structured output", () => {
  it("sends a strict-compatible schema as strict json_schema", async () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    await run("json-mode,text.generation", { prompt: "go", outputSchema: schema });
    expect(sentBodies()[0]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
  });

  it("sends any other schema as non-strict json_schema, never json_object", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    await run("json-mode,text.generation", { prompt: "go", outputSchema: schema });
    const body = sentBodies()[0]!;
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "structured_output", schema, strict: false },
    });
  });
});

describe("Meta reasoning effort", () => {
  it("offers no none level, and ultra only where max is accepted", () => {
    expect(metaEffortPolicy(cfg("muse-spark-1.3")).supported).toEqual([
      "low",
      "medium",
      "high",
      "extra",
      "ultra",
    ]);
    expect(metaEffortPolicy(cfg("muse-spark-1.2")).supported).not.toContain("ultra");
    expect(metaEffortPolicy(cfg("muse-spark-1.3-contributor")).supported).not.toContain("ultra");
    expect(metaEffortPolicy(cfg("muse-image-1.0")).supported).toEqual([]);
  });

  it("maps extra to xhigh and ultra to max", () => {
    expect(getMetaReasoningEffort(cfg("muse-wonder-1.0", { effort: "extra" }))).toBe("xhigh");
    expect(getMetaReasoningEffort(cfg("muse-wonder-1.0", { effort: "ultra" }))).toBe("max");
  });

  it("drops ultra on a model that rejects max, leaving Meta's default", () => {
    expect(
      getMetaReasoningEffort(cfg("muse-spark-1.3-contributor", { effort: "ultra" }))
    ).toBeUndefined();
  });

  it("never maps the dial's none onto the wire", () => {
    expect(getMetaReasoningEffort(cfg("muse-spark-1.3", { effort: "none" }))).toBeUndefined();
  });

  it("passes a native reasoning_effort through, minimal included", () => {
    const model = {
      provider: META,
      provider_config: { model_name: "muse-spark-1.3", reasoning_effort: "minimal" },
      effort: "high",
    } as MetaModelConfig;
    expect(getMetaReasoningEffort(model)).toBe("minimal");
  });

  it("sends the mapped effort on the request", async () => {
    await run("text.generation", { prompt: "hi" }, cfg("muse-ember-1.0", { effort: "extra" }));
    expect(sentBodies()[0]!.reasoning_effort).toBe("xhigh");
  });
});
