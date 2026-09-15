/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { describe, expect, it } from "vitest";

import type { IA2AAgentDescriptor } from "../../util/AgentDescriptor";
import { AgentTaskExecutor } from "../AgentTaskExecutor";

function recordingBus(): { bus: ExecutionEventBus; events: AgentExecutionEvent[] } {
  const events: AgentExecutionEvent[] = [];
  const bus = {
    publish: (event: AgentExecutionEvent) => void events.push(event),
    finished: () => {},
    on: () => bus,
    off: () => bus,
    once: () => bus,
    removeAllListeners: () => bus,
  } as unknown as ExecutionEventBus;
  return { bus, events };
}

function requestContext(text: string): RequestContext {
  return {
    taskId: "t1",
    contextId: "c1",
    context: {} as RequestContext["context"],
    userMessage: {
      parts: [
        {
          content: { $case: "text", value: text },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
    },
  } as unknown as RequestContext;
}

const descriptor: IA2AAgentDescriptor = {
  id: "echo",
  name: "Echo",
  description: "Says it back.",
  version: "1.0.0",
  skills: [],
  agentInput: { model: "m", tools: [] },
};

const kinds = (events: AgentExecutionEvent[]): string[] => events.map((e) => e.kind);
const stateOf = (event: AgentExecutionEvent | undefined): TaskState | undefined =>
  event?.kind === "statusUpdate" ? event.data.status?.state : undefined;

describe("AgentTaskExecutor", () => {
  it("opens with a task event, which is what the server requires", async () => {
    // The server rejects a stream that begins with a statusUpdate or an
    // artifactUpdate, so this ordering is not a style choice.
    const { bus, events } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: async () => ({ text: "hello" }),
    });
    await executor.execute(requestContext("hi"), bus);
    expect(kinds(events)[0]).toBe("task");
  });

  it("ends completed, with the answer as an artifact", async () => {
    const { bus, events } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: async () => ({ text: "hello" }),
    });
    await executor.execute(requestContext("hi"), bus);

    expect(kinds(events)).toEqual(["task", "artifactUpdate", "statusUpdate"]);
    const artifact = events[1];
    expect(
      artifact?.kind === "artifactUpdate" && artifact.data.artifact?.parts[0]?.content
    ).toEqual({ $case: "text", value: "hello" });
    // Terminal by state: the protocol has no separate final flag.
    expect(stateOf(events[2])).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("hands the model the text the caller sent", async () => {
    const seen: string[] = [];
    const { bus } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: async (input) => {
        seen.push(String(input.prompt ?? ""));
        return { text: "ok" };
      },
    });
    await executor.execute(requestContext("what changed?"), bus);
    expect(seen).toEqual(["what changed?"]);
  });

  it("keeps the descriptor's own input out of the caller's reach", async () => {
    // The caller supplies a prompt; the model, system prompt and tools are the
    // host's, and a peer must not be able to overwrite them.
    let seen: Record<string, unknown> = {};
    const { bus } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor: { ...descriptor, agentInput: { model: "m", systemPrompt: "sys", tools: [] } },
      runTurn: async (input) => {
        seen = input;
        return { text: "ok" };
      },
    });
    await executor.execute(requestContext("hi"), bus);
    expect(seen).toMatchObject({ model: "m", systemPrompt: "sys", prompt: "hi" });
  });

  it("ends failed when the turn throws, rather than hanging the caller", async () => {
    const { bus, events } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: async () => {
        throw new Error("model unavailable");
      },
    });
    await executor.execute(requestContext("hi"), bus);

    const last = events[events.length - 1];
    expect(stateOf(last)).toBe(TaskState.TASK_STATE_FAILED);
    // The reason stays on the server: the peer learns that the agent failed,
    // not what its host's error message carried.
    const said =
      last?.kind === "statusUpdate" ? last.data.status?.message?.parts[0]?.content : undefined;
    expect(said).toEqual({ $case: "text", value: "The agent failed to answer." });
  });

  it("names the unbound ports when the caller's parts cannot be bound", async () => {
    const { bus, events } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor: {
        ...descriptor,
        skills: [
          {
            id: "two",
            name: "Two",
            description: "",
            tags: [],
            examples: [],
            inputSchema: {
              type: "object",
              properties: { a: { type: "string" }, b: { type: "string" } },
              required: ["a", "b"],
            },
          },
        ],
      },
      runTurn: async () => ({ text: "never" }),
    });
    await executor.execute(requestContext("hi"), bus);
    const last = events[events.length - 1];
    expect(stateOf(last)).toBe(TaskState.TASK_STATE_FAILED);
    const said =
      last?.kind === "statusUpdate" ? last.data.status?.message?.parts[0]?.content : undefined;
    expect(said?.$case === "text" && said.value).toMatch(/a, b/);
  });

  it("never publishes input-required", async () => {
    // Parking is a later phase and changes a published type. Until then an
    // agent that would ask a person fails loudly rather than parking a task no
    // resume path can reach.
    const { bus, events } = recordingBus();
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: async () => ({ text: "hello" }),
    });
    await executor.execute(requestContext("hi"), bus);
    const states = events.flatMap((e) => (e.kind === "statusUpdate" ? [stateOf(e)] : []));
    expect(states).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  it("cancels into a final canceled status, and aborts the running turn", async () => {
    const { bus, events } = recordingBus();
    let aborted = false;
    const executor = new AgentTaskExecutor({
      descriptor,
      runTurn: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const run = executor.execute(requestContext("hi"), bus);
    await executor.cancelTask("t1", bus);
    await run;
    expect(aborted).toBe(true);
    const canceled = events.find((e) => stateOf(e) === TaskState.TASK_STATE_CANCELED);
    expect(canceled?.kind === "statusUpdate" && canceled.data.contextId).toBe("c1");
  });
});
