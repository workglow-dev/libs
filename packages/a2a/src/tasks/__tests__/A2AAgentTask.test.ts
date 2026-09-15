/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";

import type { A2AClientLike } from "../A2AAgentTask";
import { A2AAgentTask, agentBaseUrl } from "../A2AAgentTask";

function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function fakeClient(reply: { text: string; contextId: string; state: string }): A2AClientLike {
  return {
    sendMessage: async () => ({
      contextId: reply.contextId,
      state: reply.state,
      parts: [textPart(reply.text)],
    }),
  };
}

describe("agentBaseUrl", () => {
  it("accepts the card URL a server prints, as well as the base it hangs off", () => {
    // The SDK resolves the well-known path relative to what it is handed, so
    // the card's own URL would otherwise look for the card underneath itself.
    expect(agentBaseUrl("http://h:1/.well-known/agent-card.json")).toBe("http://h:1/");
    expect(agentBaseUrl("http://h:1/x/.well-known/agent-card.json")).toBe("http://h:1/x");
    expect(agentBaseUrl("http://h:1")).toBe("http://h:1/");
  });
});

describe("A2AAgentTask", () => {
  it("declares a title, because the progress UI labels the row with it", () => {
    expect(A2AAgentTask.title).toBeTruthy();
  });

  it("returns the remote agent's answer and the context to continue in", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "hello", contextId: "c1", state: "TASK_STATE_COMPLETED" }),
    });
    const out = await task.run();
    expect(out.text).toBe("hello");
    expect(out.contextId).toBe("c1");
  });

  it("carries a caller's contextId through to the remote agent", async () => {
    const seen: (string | undefined)[] = [];
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "and then?", contextId: "c1" },
      createClient: async () => ({
        sendMessage: async (input) => {
          seen.push(input.contextId);
          return { contextId: "c1", state: "TASK_STATE_COMPLETED", parts: [textPart("ok")] };
        },
      }),
    });
    await task.run();
    // Without this the second turn opens a new conversation and the remote
    // agent has forgotten the first.
    expect(seen).toEqual(["c1"]);
  });

  it("reports a remote task that stopped for input rather than calling it an answer", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "which year?", contextId: "c1", state: "TASK_STATE_INPUT_REQUIRED" }),
    });
    const out = await task.run();
    // A caller reading this as an answer never sends the follow-up, and the
    // remote task stays parked until it expires.
    expect(out.taskState).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  it("fails when the remote task failed, carrying the peer's reason", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "model unavailable", contextId: "c1", state: "TASK_STATE_FAILED" }),
    });
    // An empty answer with a state nobody downstream reads is a pipeline that
    // reports success on a call that produced nothing.
    await expect(task.run()).rejects.toThrow(/TASK_STATE_FAILED.*model unavailable/);
  });

  it("hands the run's signal to the call, not just to a check before it", async () => {
    let received: AbortSignal | undefined;
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () => ({
        sendMessage: async (_input, signal) => {
          received = signal;
          return { contextId: "c1", state: "TASK_STATE_COMPLETED", parts: [textPart("ok")] };
        },
      }),
    });
    await task.run();
    // An aborted run that only checked beforehand leaves a remote turn in
    // flight, and the peer bills for it.
    expect(received).toBeInstanceOf(AbortSignal);
  });
});
