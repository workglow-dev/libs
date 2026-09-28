/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/cactus/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { expectNoFinishAccumulation } from "@workglow/test-contract/ai-provider";
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
}): Promise<{
  names: string[];
  textDeltas: string[];
  text: string;
  finishText: string;
  events: StreamEvent<never>[];
}> {
  cactusEngines.set("needle-26m", engine as never);
  const names: string[] = [];
  const textDeltas: string[] = [];
  const events: StreamEvent<never>[] = [];
  let finishText = "";
  const controller = new AbortController();
  await Cactus_ToolCalling(
    { prompt: "What's the weather in Paris?", tools, toolChoice: "auto" } as never,
    model as never,
    controller.signal,
    (ev) => {
      events.push(ev as StreamEvent<never>);
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
  // Every case runs the generic guard, so a `finish` that starts carrying the
  // generation again fails wherever it is reintroduced rather than only where
  // someone remembered to look.
  expectNoFinishAccumulation(events);
  // `text` is what a consumer ends up with: `TaskRunner` accumulates the
  // deltas. `finishText` is kept so a case can assert the run-fn adds nothing
  // on top of them.
  return { names, textDeltas, text: textDeltas.join(""), finishText, events };
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
    const { names, text, finishText } = await runToolCalling({
      run: () => `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
      run_json: () => `<tool_call>[]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
    // The one-shot generation goes through the same text filter as a stream
    // would, so the payload reaches `toolCalls` and not `text`.
    expect(text).toBe("");
    expect(finishText).toBe("");
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
    expect(textDeltas.join("")).toBe("");
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
    expect(textDeltas.join("")).toBe("");
  });

  it("emits nothing for a token the callback reports without a text piece", async () => {
    const { textDeltas } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb(42);
        cb(43, "Paris is sunny.");
        return "Paris is sunny.";
      },
    });
    expect(textDeltas.join("")).toBe("Paris is sunny.");
  });
});

/**
 * v3 reasons before essentially every answer, so `text` would otherwise carry
 * the chain of thought — a host rendering it beside the tool cards would show
 * it, and a host logging it would persist it. `text` means the model's answer
 * for v1 and v2, and has to keep meaning that here.
 */
describe("Cactus_ToolCalling v3 reasoning on the text port", () => {
  it("keeps a <think> block out of the text a one-shot generation yields", async () => {
    const { names, text } = await runToolCalling({
      run: () =>
        `<think>The user wants Paris weather, so lookup_weather.</think>` +
        `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`,
    });
    expect(names).toEqual(["lookup_weather"]);
    expect(text).not.toContain("<think>");
    expect(text).not.toContain("The user wants Paris weather");
  });

  it("keeps a <think> block out of the stream even when tags straddle deltas", async () => {
    const { names, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        // The tags arrive split, which is what makes this more than a replace.
        cb("<thi");
        cb("nk>secret reasoning");
        cb(" continues</thi");
        cb("nk>Paris is sunny.");
        cb(`<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`);
        return (
          `<think>secret reasoning continues</think>Paris is sunny.` +
          `<tool_call>[{"name":"lookup_weather","arguments":{"city":"Paris"}}]</tool_call>`
        );
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expect(text).not.toContain("secret reasoning");
    expect(text).not.toContain("<think>");
    expect(text).toContain("Paris is sunny.");
  });

  it("releases an unterminated <think> rather than swallowing the generation", async () => {
    // Cut off at the token limit: there is no closing tag, and the parser
    // deliberately leaves such a block alone, so the stream must too.
    const { text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("<think>reasoning that never closes");
        return "<think>reasoning that never closes";
      },
    });
    expect(text).toBe("<think>reasoning that never closes");
  });

  it("does not hold back text that merely starts like a tag", async () => {
    const { text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("a < b and c <th");
        cb("an d");
        return "a < b and c <than d";
      },
    });
    expect(text).toBe("a < b and c <than d");
  });
});

/**
 * The payload belongs on `toolCalls`. Forwarded to `text` as well, a host
 * rendering that port live shows the call's JSON typing itself out before the
 * tool card appears, and a host persisting `text` stores it twice.
 */
describe("Cactus_ToolCalling tool-call markup on the text port", () => {
  const PARIS = `[{"name":"lookup_weather","arguments":{"city":"Paris"}}]`;

  /** Fails on any fragment of the markup or payload, not only a whole tag. */
  function expectNoMarkup(textDeltas: readonly string[]): void {
    for (const delta of textDeltas) {
      expect(delta).not.toMatch(/<\/?tool|_call>|lookup_weather|book_flight|arguments|\[\{|\}\]/);
    }
    expect(textDeltas.join("")).not.toMatch(/tool_call|lookup_weather|book_flight|\[\{/);
  }

  it("v1: drops the unterminated <tool_call> run_stream shows while it decodes", async () => {
    // Captured from needle-rs: v1 streams the raw generation — a
    // `<tool_call>` token, then the payload, never a closing tag — and
    // returns the post-processed bare JSON.
    const pieces = [
      "<tool_call>",
      ' [{"',
      "name",
      '":"',
      "look",
      "up",
      "_",
      "weather",
      '","',
      "arguments",
      '":{"',
      "city",
      '":"',
      "P",
      "aris",
      '"}}]',
    ];
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        pieces.forEach((piece, i) => cb(i, piece));
        return ` ${PARIS}`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("");
  });

  it("v1: drops the bare JSON payload a one-shot run() returns", async () => {
    const { names, textDeltas, text } = await runToolCalling({ run: () => ` ${PARIS}` });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("");
  });

  it("drops a bare JSON payload streamed with no fence at all", async () => {
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("[{");
        cb('"name":"lookup_');
        cb('weather","arguments":{"city":"Paris"}');
        cb("}]");
        return PARIS;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("");
  });

  it("releases held text that starts like JSON but is not a payload", async () => {
    const { names, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("[note] ");
        cb("no tool fits");
        return "[note] no tool fits";
      },
    });
    expect(names).toEqual([]);
    expect(text).toBe("[note] no tool fits");
  });

  it("releases an answer that is valid JSON but names no tool", async () => {
    const answer = `{"answer":"Paris is sunny"}`;
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb('{"answer":');
        cb('"Paris is sunny"}');
        return answer;
      },
    });
    expect(names).toEqual([]);
    expect(textDeltas.join("")).toBe(answer);
    expect(text).toBe(answer);
  });

  it("releases a JSON array whose entries are not tool calls", async () => {
    const { names, text } = await runToolCalling({ run: () => "[1, 2, 3]" });
    expect(names).toEqual([]);
    expect(text).toBe("[1, 2, 3]");
  });

  it("drops the bare [] abstention", async () => {
    const { names, textDeltas, text } = await runToolCalling({ run: () => "[]" });
    expect(names).toEqual([]);
    expect(textDeltas).toEqual([]);
    expect(text).toBe("");
  });

  it("v2: drops a fenced payload streamed one token per piece", async () => {
    // Token boundaries as needle-rs v2 reports them.
    const pieces = [
      "<tool_call>",
      '[{"',
      "name",
      '":"',
      "l",
      "ook",
      "up",
      "_",
      "we",
      "ather",
      '","',
      "arguments",
      '":{"',
      "c",
      "ity",
      '":"',
      "P",
      "ar",
      "is",
      '"}}]',
      "</tool_call>",
    ];
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        pieces.forEach((piece, i) => cb(i, piece));
        return `<tool_call>${PARIS}</tool_call>`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("");
  });

  it("v2: drops an abstention payload of []", async () => {
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        for (const piece of ["<think>", "\n", "No tool fits.", "\n", "</think>", "\n"]) {
          cb(0, piece);
        }
        for (const piece of ["<tool_call>", "[", "]", "</tool_call>"]) cb(0, piece);
        return `<think>\nNo tool fits.\n</think>\n<tool_call>[]</tool_call>`;
      },
    });
    expect(names).toEqual([]);
    expect(textDeltas.join("")).not.toContain("[]");
    expect(text).toBe("");
  });

  it("v3: leaves nothing of the reasoning or the payload on the text port", async () => {
    // needle-rs v3's shape: reasoning, a newline, then the fenced payload.
    const pieces = [
      "<think>",
      "\n",
      "Query asks for weather in Paris.",
      "\n",
      "</think>",
      "\n",
      "<tool_call>",
      '[{"',
      "name",
      '":"',
      "look",
      "up",
      "_",
      "weather",
      '","',
      "arguments",
      '":{"',
      "c",
      "ity",
      '":"',
      "Par",
      "is",
      '"}}]',
      "</tool_call>",
    ];
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        for (const piece of pieces) cb(piece);
        return pieces.join("");
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).not.toContain("Query asks");
    expect(text).toBe("");
  });

  it("drops markup whose tags straddle chunk boundaries, keeping the prose around it", async () => {
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("Checking the weather. <to");
        cb("ol_ca");
        cb('ll>[{"name":"lookup_wea');
        cb('ther","arguments":{"city":"Paris"}}]</tool');
        cb("_call> Done.");
        return `Checking the weather. <tool_call>${PARIS}</tool_call> Done.`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("Checking the weather.  Done.");
  });

  it("drops every fenced block, not just the first", async () => {
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb(`<tool_call>${PARIS}</tool_call>`);
        cb(" and ");
        cb(`<tool_call>[{"name":"book_flight","arguments":{"origin":"LHR"}}]</tool_call>`);
        return (
          `<tool_call>${PARIS}</tool_call> and ` +
          `<tool_call>[{"name":"book_flight","arguments":{"origin":"LHR"}}]</tool_call>`
        );
      },
    });
    expect(names).toEqual(["lookup_weather", "book_flight"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe(" and ");
  });

  it("drops a fenced payload cut off at the token limit, and still parses it", async () => {
    const { names, textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("<tool_call>");
        cb(PARIS);
        return `<tool_call>${PARIS}`;
      },
    });
    expect(names).toEqual(["lookup_weather"]);
    expectNoMarkup(textDeltas);
    expect(text).toBe("");
  });

  it("holds back a partial opening tag and releases it once it is not one", async () => {
    const { textDeltas, text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("Open the <tool");
        cb("box, please.");
        return "Open the <toolbox, please.";
      },
    });
    expect(textDeltas[0]).toBe("Open the ");
    expect(text).toBe("Open the <toolbox, please.");
  });

  it("releases a partial opening tag the stream ends on", async () => {
    const { text } = await runToolCalling({
      run: () => "unused",
      run_stream: async (_q, _t, cb) => {
        cb("ends mid-tag <tool_ca");
        return "ends mid-tag <tool_ca";
      },
    });
    expect(text).toBe("ends mid-tag <tool_ca");
  });
});
