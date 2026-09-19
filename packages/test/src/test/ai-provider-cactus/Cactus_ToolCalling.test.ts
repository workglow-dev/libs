/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/cactus/ai";
import { afterEach, describe, expect, it } from "vitest";
import { runFnFor } from "./test-utils";

const { cactusEngines } = _testOnly;
const Cactus_ToolCalling = runFnFor(["tool-use"]);

const tools = [
  {
    name: "lookup_weather",
    description: "Look up the weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "book_flight",
    description: "Book a flight out of an airport",
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string" } },
      required: ["origin"],
    },
  },
];

const model = {
  model_id: "test",
  title: "",
  description: "",
  provider: "LOCAL_CACTUS",
  provider_config: { model_id: "needle-26m" },
  capabilities: ["tool-use"],
  metadata: {},
};

afterEach(() => {
  cactusEngines.clear();
});

async function runToolCalling(engine: {
  run: (q: string, t: string) => string | Promise<string>;
  run_json?: (q: string, t: string) => string | Promise<string>;
  run_stream?: (
    q: string,
    t: string,
    cb: (tokenIdOrChunk: number | string, piece?: string) => void
  ) => string | Promise<string>;
}): Promise<{ names: string[]; textDeltas: string[]; finishText: string }> {
  cactusEngines.set("needle-26m", engine as never);
  const names: string[] = [];
  const textDeltas: string[] = [];
  let finishText = "";
  const controller = new AbortController();
  await Cactus_ToolCalling(
    { prompt: "What's the weather in Paris?", tools, toolChoice: "auto" } as never,
    model as never,
    controller.signal,
    (ev) => {
      if (ev.type === "text-delta" && ev.port === "text") {
        textDeltas.push(ev.textDelta);
      }
      if (ev.type === "object-delta" && ev.port === "toolCalls") {
        for (const call of ev.objectDelta as Array<{ name: string }>) {
          names.push(call.name);
        }
      }
      if (ev.type === "finish") {
        finishText = ev.data.text;
      }
    }
  );
  return { names, textDeltas, finishText };
}

describe("Cactus_ToolCalling output parsing", () => {
  it("parses a v1 bare JSON tool-call array", async () => {
    const { names } = await runToolCalling({
      run: () => JSON.stringify([{ name: "lookup_weather", arguments: { city: "Paris" } }]),
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("parses a v2 <tool_call>-wrapped JSON payload", async () => {
    const { names } = await runToolCalling({
      run: () => `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("treats an empty v2 tool_call payload as no calls", async () => {
    const { names } = await runToolCalling({
      run: () => `<tool_call>[]</tool_call>`,
    });
    expect(names).toEqual([]);
  });

  it("collects calls from every tool_call block, not just the first", async () => {
    const { names } = await runToolCalling({
      run: () =>
        `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>` +
        `<tool_call>[{"name":"book_flight","arguments":{"origin":"LHR"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather", "book_flight"]);
  });

  it("recovers the payload when generation is cut off before the closing tag", async () => {
    const { names } = await runToolCalling({
      run: () => `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]`,
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("keeps the well-formed calls when a sibling entry is not an object", async () => {
    const { names } = await runToolCalling({
      run: () =>
        `<tool_call>[null,{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("ignores run_json and falls back to run() when run_stream is absent", async () => {
    const { names, finishText } = await runToolCalling({
      run: () => `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
      run_json: () => `<tool_call>[]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
    expect(finishText).toContain("lookup_weather");
  });

  it("parses a v3 payload that follows a <think> reasoning block", async () => {
    const { names } = await runToolCalling({
      run: () =>
        `<think>The user wants weather for Paris, so lookup_weather with city Paris.</think>` +
        `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("ignores a tool_call the model only discussed inside its reasoning", async () => {
    // v3 reasons before nearly every answer, so reasoning that quotes the
    // markers must not be mistaken for an emitted call.
    const { names } = await runToolCalling({
      run: () =>
        `<think>I could answer with <tool_call>[{"name":"book_flight","arguments":{"origin":"LHR"}}]</tool_call> but the user asked about weather.</think>` +
        `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
  });

  it("treats a v3 reasoning-only completion as no calls", async () => {
    const { names } = await runToolCalling({
      run: () => `<think>None of these tools answer the question.</think>`,
    });
    expect(names).toEqual([]);
  });

  it("treats a v3 abstention payload of [] as no calls", async () => {
    const { names } = await runToolCalling({
      run: () => `<think>No tool fits.</think><tool_call>[]</tool_call>`,
    });
    expect(names).toEqual([]);
  });

  it("accepts v3 run_stream(text) single-argument callback shape", async () => {
    // v3 changed the callback: it passes the decoded delta alone, where v1
    // and v2 pass (tokenId, piece).
    const { names, textDeltas } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("<tool_call>[");
        cb('{"name":"lookup_weather","arguments":{"city":"Paris"}}');
        cb("]</tool_call>");
        return `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expect(textDeltas.join("")).toBe(
      `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`
    );
  });

  it("accepts v2 run_stream(tokenId, piece) callback shape", async () => {
    const { names, textDeltas } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb(0, "<tool_call>[");
        cb(1, '{"name":"lookup_weather","arguments":{"city":"Paris"}}');
        cb(2, "]</tool_call>");
        return `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expect(textDeltas.join("")).toContain("lookup_weather");
  });

  it("emits nothing for a token the callback reports without a text piece", async () => {
    const { textDeltas } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb(42);
        cb(43, "<tool_call>[]</tool_call>");
        return `<tool_call>[]</tool_call>`;
      },
    });
    expect(textDeltas.join("")).toBe("<tool_call>[]</tool_call>");
  });
});
