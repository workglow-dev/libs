/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatMessage,
  ContentBlock,
  ToolCallingTaskOutput,
  ToolDefinition,
} from "@workglow/ai";
import { accumulatingEmit } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { expect } from "vitest";

import type {
  ScriptedReply,
  ScriptedToolCall,
  ToolTurnConformanceOpts,
  ToolTurnHarness,
  WireTurn,
} from "./toolTurnTypes";

/**
 * Every marker is a string no converter would write on its own, so finding one
 * in a request says where that piece of the conversation went.
 */
export const TOOL_TURN_FIXTURE = {
  question: "What is the weather in Paris right now?",
  reasoning: "Conformance-reasoning: the user wants Paris weather, so call get_weather.",
  text: "Conformance-text: let me look that up.",
  call: { id: "conformance_call_1", name: "get_weather", input: { location: "Paris" } },
  resultText: "Conformance-result: 18C and cloudy.",
  /** Base64 of a 1x1 PNG, long enough that no other value contains it by accident. */
  image: {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  },
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
    {
      name: "get_time",
      description: "Get the current time in a city.",
      inputSchema: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
  ] as const satisfies ReadonlyArray<ToolDefinition>,
} as const;

/** What one run of the run-fn produced. */
export interface ToolTurnRound {
  readonly events: ReadonlyArray<StreamEvent<ToolCallingTaskOutput>>;
  readonly output: ToolCallingTaskOutput;
  /** The request this run sent; the last one when the run-fn sent several. */
  readonly request: unknown;
}

export const userTurn: ChatMessage = {
  role: "user",
  content: [{ type: "text", text: TOOL_TURN_FIXTURE.question }],
};

/** Runs one round: queues `reply`, runs the run-fn over `messages`, accumulates as a task would. */
export async function runToolTurnRound(
  harness: ToolTurnHarness,
  messages: ReadonlyArray<ChatMessage>,
  reply: ScriptedReply = { text: "ok" }
): Promise<ToolTurnRound> {
  const before = harness.sent().length;
  harness.respond(reply);
  const events: StreamEvent<ToolCallingTaskOutput>[] = [];
  const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
  await harness.run(
    { prompt: TOOL_TURN_FIXTURE.question, messages, tools: TOOL_TURN_FIXTURE.tools },
    (event) => {
      events.push(event);
      accumulator.emit(event);
    }
  );
  const sent = harness.sent();
  expect(sent.length, "the run-fn sent no request through the harness").toBeGreaterThan(before);
  return { events, output: accumulator.result(), request: sent[sent.length - 1] };
}

/** Text the run-fn put on one port, in order. */
export function portText(
  events: ReadonlyArray<StreamEvent<ToolCallingTaskOutput>>,
  port: string
): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text-delta" && event.port === port) text += event.textDelta;
  }
  return text;
}

/** Every `nativeTurn` the run-fn emitted. */
export function nativeTurns(
  events: ReadonlyArray<StreamEvent<ToolCallingTaskOutput>>
): ReadonlyArray<{ readonly provider: string; readonly payload: string }> {
  const turns: Array<{ readonly provider: string; readonly payload: string }> = [];
  for (const event of events) {
    if (event.type === "object-delta" && event.port === "nativeTurn") {
      turns.push(event.objectDelta as unknown as { provider: string; payload: string });
    }
  }
  return turns;
}

/**
 * The assistant message a turn records for a round, as `AgentTask` writes it:
 * the reasoning first (with the native turn when there is one), then the text,
 * then each call with whatever signature it carried.
 */
export function recordedAssistantTurn(output: ToolCallingTaskOutput): ChatMessage {
  const content: ContentBlock[] = [];
  if (output.nativeTurn) {
    content.push({
      type: "reasoning",
      text: output.reasoning ?? "",
      provider: output.nativeTurn.provider,
      payload: output.nativeTurn.payload,
    });
  } else if (output.reasoning) {
    content.push({ type: "reasoning", text: output.reasoning });
  }
  if (output.text) content.push({ type: "text", text: output.text });
  for (const call of output.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
      ...(call.providerSignature === undefined
        ? {}
        : { providerSignature: call.providerSignature }),
    });
  }
  return { role: "assistant", content };
}

/** A tool message answering each call in `assistant` with `content`. */
export function toolResults(
  assistant: ChatMessage,
  content: Extract<ContentBlock, { type: "tool_result" }>["content"] = [
    { type: "text", text: TOOL_TURN_FIXTURE.resultText },
  ]
): ChatMessage {
  return {
    role: "tool",
    content: assistant.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        type: "tool_result" as const,
        tool_use_id: (block as { id: string }).id,
        content,
        is_error: undefined,
      })),
  };
}

/** The scripted round with reasoning, text and one call that every round-trip case starts from. */
export const reasoningCallReply: ScriptedReply = {
  reasoning: TOOL_TURN_FIXTURE.reasoning,
  text: TOOL_TURN_FIXTURE.text,
  toolCalls: [TOOL_TURN_FIXTURE.call as ScriptedToolCall],
};

/** A history with one call to `call` already answered, for the tool-result cases. */
export function answeredCallHistory(
  content: Extract<ContentBlock, { type: "tool_result" }>["content"]
): ChatMessage[] {
  const assistant: ChatMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: TOOL_TURN_FIXTURE.call.id,
        name: TOOL_TURN_FIXTURE.call.name,
        input: TOOL_TURN_FIXTURE.call.input,
      },
    ],
  };
  return [userTurn, assistant, toolResults(assistant, content)];
}

// ---------------------------------------------------------------------------
// Searching a captured request
// ---------------------------------------------------------------------------

type Path = ReadonlyArray<string | number>;

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => isDeepEqual(value, other[i]));
  }
  // Undefined-valued keys are what a JSON body would drop, so they do not count.
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) =>
      isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    )
  );
}

/**
 * Whether `needle` appears in `haystack` unchanged: as a value anywhere in it,
 * or, for an array needle, as a contiguous run of some array in it — a
 * Responses turn is spliced into `input` item by item rather than nested.
 */
export function containsVerbatim(haystack: unknown, needle: unknown): boolean {
  if (isDeepEqual(haystack, needle)) return true;
  if (Array.isArray(haystack)) {
    if (Array.isArray(needle) && needle.length > 0 && needle.length <= haystack.length) {
      for (let start = 0; start + needle.length <= haystack.length; start++) {
        if (needle.every((value, i) => isDeepEqual(haystack[start + i], value))) return true;
      }
    }
    return haystack.some((value) => containsVerbatim(value, needle));
  }
  if (typeof haystack === "object" && haystack !== null) {
    return Object.values(haystack).some((value) => containsVerbatim(value, needle));
  }
  return false;
}

/** The path to the first string in `value` containing `fragment`, or undefined. */
export function pathToText(value: unknown, fragment: string, path: Path = []): Path | undefined {
  if (typeof value === "string") return value.includes(fragment) ? path : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = pathToText(value[i], fragment, [...path, i]);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const found = pathToText(inner, fragment, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Index of the first turn holding a string that contains `fragment`, or -1. */
export function turnHolding(turns: ReadonlyArray<WireTurn>, fragment: string): number {
  return turns.findIndex((turn) => pathToText(turn.body, fragment) !== undefined);
}

/** Splits a captured request into turns, refusing an empty split so a bad splitter fails loudly. */
export function wireTurns(
  opts: ToolTurnConformanceOpts,
  request: unknown
): ReadonlyArray<WireTurn> {
  const turns = opts.turns(request);
  expect(turns.length, "turns() found no conversation in the captured request").toBeGreaterThan(0);
  return turns;
}
