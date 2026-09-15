/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from "vitest";

import { A2AAgentTask } from "../../tasks/A2AAgentTask";
import type { IA2AAgentDescriptor } from "../../util/AgentDescriptor";
import { startA2AHttpServer } from "../A2AHttpServer";

/** The prompt a turn was handed, as text; the type also admits content blocks. */
const promptText = (prompt: unknown): string =>
  typeof prompt === "string" ? prompt : JSON.stringify(prompt);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const descriptor: IA2AAgentDescriptor = {
  id: "echo",
  name: "Echo",
  description: "Says it back.",
  version: "1.0.0",
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Says it back.",
      tags: [],
      examples: [],
      inputSchema: undefined,
    },
  ],
  agentInput: { model: "m", tools: [] },
};

/**
 * The client task against the server, through the SDK's real client and wire.
 * The unit suites pin each half; only this proves the two meet — card
 * discovery, the JSON-RPC request the SDK actually sends, and the task state
 * coming back as the name the port expects.
 */
describe("A2AAgentTask against startA2AHttpServer", () => {
  it("gets an answer back, and a context to continue in", async () => {
    const prompts: string[] = [];
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async (input) => {
        prompts.push(promptText(input.prompt));
        return { text: `you said: ${promptText(input.prompt)}` };
      },
    });
    close = handle.close;

    const first = await new A2AAgentTask({
      defaults: { agentUrl: handle.cardUrl, prompt: "hello", contextId: undefined },
    }).run();
    expect(first.text).toBe("you said: hello");
    expect(first.taskState).toBe("TASK_STATE_COMPLETED");
    expect(first.contextId).not.toBe("");

    const second = await new A2AAgentTask({
      defaults: { agentUrl: handle.cardUrl, prompt: "again", contextId: first.contextId },
    }).run();
    expect(second.contextId).toBe(first.contextId);
    expect(prompts).toEqual(["hello", "again"]);
  });

  it("fails the task when the remote agent fails, with the peer's reason", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => {
        throw new Error("no model here");
      },
    });
    close = handle.close;

    const task = new A2AAgentTask({
      defaults: { agentUrl: handle.cardUrl, prompt: "hello", contextId: undefined },
    });
    await expect(task.run()).rejects.toThrow(/TASK_STATE_FAILED: The agent failed to answer/);
  });
});
