/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, StreamToolCall } from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import { describe, expect, it } from "vitest";
import type { AgentToolRoundOptions, AgentToolRoundResult } from "../AgentToolRound";
import { assistantMessage, isAnswerable, runToolRound } from "../AgentToolRound";
import { AGENT_SUBMIT_TOOL_NAME } from "../AgentTurnRecord";
import type { ToolCall, ToolDefinition } from "../ToolCallingUtils";
import { compileToolValidators } from "../ToolCallingUtils";

function context(): IExecuteContext {
  return {
    registry: new ServiceRegistry(new Container()),
    signal: new AbortController().signal,
    updateProgress: async () => {},
  } as unknown as IExecuteContext;
}

/** A host tool finishing after `ms`, so calls run at once finish out of order. */
function tool(name: string, ms: number): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    requiresApproval: false,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${name} done`;
    },
  };
}

function optionsFor(tools: readonly ToolDefinition[], concurrency = 1): AgentToolRoundOptions {
  return {
    byName: new Map(tools.map((t) => [t.name, t])),
    validators: compileToolValidators(tools),
    approval: "beyond-inference",
    concurrency,
    maxResultChars: 1_000,
    deadline: undefined,
    submitToolName: AGENT_SUBMIT_TOOL_NAME,
  };
}

async function drain(
  run: AsyncGenerator<StreamToolCall, AgentToolRoundResult, undefined>
): Promise<{ readonly events: StreamToolCall[]; readonly round: AgentToolRoundResult }> {
  const events: StreamToolCall[] = [];
  for (;;) {
    const next = await run.next();
    if (next.done) return { events, round: next.value };
    events.push(next.value);
  }
}

function textOf(round: AgentToolRoundResult, index: number): string {
  const block = round.results[index]!.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("runToolRound", () => {
  it("announces every call, then answers each in the order asked", async () => {
    const tools = [tool("slow", 30), tool("fast", 1)];
    const calls: ToolCall[] = [
      { id: "a", name: "slow", input: {} },
      { id: "b", name: "fast", input: {} },
    ];
    const { events, round } = await drain(runToolRound(calls, context(), optionsFor(tools, 2)));
    expect(events.slice(0, 2).map((e) => [e.status, e.toolCallId])).toEqual([
      ["pending", "a"],
      ["pending", "b"],
    ]);
    // Run at once, the fast call settles first; the results still follow the request.
    const completed = events.filter((e) => e.status === "completed").map((e) => e.toolCallId);
    expect(completed).toEqual(["b", "a"]);
    expect(round.results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(round.records.map((r) => [r.id, r.isError, r.chars])).toEqual([
      ["a", false, "slow done".length],
      ["b", false, "fast done".length],
    ]);
  });

  it("answers an unknown tool and rejected arguments as errors, never dropping the call", async () => {
    const tools = [tool("echo", 0)];
    const calls: ToolCall[] = [
      { id: "a", name: "nope", input: {} },
      { id: "b", name: "echo", input: { n: "not a number" } },
      { id: "c", name: AGENT_SUBMIT_TOOL_NAME, input: {} },
    ];
    const submit: ToolDefinition = {
      ...tool(AGENT_SUBMIT_TOOL_NAME, 0),
      inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    };
    const { events, round } = await drain(
      runToolRound(calls, context(), optionsFor([...tools, submit]))
    );
    expect(round.results.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(textOf(round, 0)).toContain('Unknown tool "nope"');
    expect(textOf(round, 1)).toContain("Invalid arguments for echo");
    expect(textOf(round, 2)).toContain("Answer rejected; nothing was recorded");
    expect(events.filter((e) => e.status === "failed")).toHaveLength(3);
  });

  it("clamps a result to the round's character budget", async () => {
    const long: ToolDefinition = { ...tool("long", 0), execute: async () => "x".repeat(50) };
    const { round } = await drain(
      runToolRound([{ id: "a", name: "long", input: {} }], context(), {
        ...optionsFor([long]),
        maxResultChars: 10,
      })
    );
    expect(textOf(round, 0).startsWith("xxxxxxxxxx")).toBe(true);
    expect(textOf(round, 0)).toContain("truncated");
  });
});

describe("assistantMessage", () => {
  it("carries reasoning only beside a reply, and the native turn when there is one", () => {
    expect(assistantMessage("", [], "thought", undefined).content).toEqual([]);
    const call: ToolCall = { id: "a", name: "echo", input: {} };
    expect(
      assistantMessage("", [call], "thought", { provider: "p", payload: "x" }).content
    ).toEqual([
      { type: "reasoning", text: "thought", provider: "p", payload: "x" },
      { type: "tool_use", id: "a", name: "echo", input: {} },
    ]);
  });

  it("refuses a call with no id or name as answerable", () => {
    expect(isAnswerable({ id: "", name: "echo", input: {} })).toBe(false);
    expect(isAnswerable({ id: "a", name: "echo", input: {} })).toBe(true);
  });
});
