/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelConfig } from "@workglow/ai";
import {
  AiProviderRegistry,
  DirectExecutionStrategy,
  getAiProviderRegistry,
  setAiProviderRegistry,
} from "@workglow/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IHumanRequest } from "@workglow/util";
import { Container, HUMAN_CONNECTOR, ServiceRegistry } from "@workglow/util";
import {
  askThroughConnector,
  chatRegistry,
  CHAT_MESSAGE_SCHEMA,
  runAgentChat,
  type AgentChatIo,
} from "../agent/runAgentChat";

const PROVIDER = "mock-chat-provider";

const MODEL: ModelConfig = {
  model_id: "mock/chat-1",
  provider: PROVIDER,
  title: "",
  description: "",
  capabilities: ["tool-use"],
  provider_config: {},
  metadata: {},
};

/** Answers each turn with the next scripted reply; the last repeats. */
function scriptModel(replies: readonly string[]): () => number {
  let called = 0;
  const runFn: AiProviderRunFn = async (_input, _model, _signal, emit) => {
    const reply = replies[Math.min(called, replies.length - 1)]!;
    called++;
    emit({ type: "text-delta", port: "text", textDelta: reply });
    emit({ type: "finish", data: {} });
  };
  getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
  return () => called;
}

/** How many messages the model was handed, per turn. */
function historySizes(): { readonly sizes: number[]; readonly runFn: AiProviderRunFn } {
  const sizes: number[] = [];
  const runFn: AiProviderRunFn = async (input, _model, _signal, emit) => {
    sizes.push(((input as { messages?: unknown[] }).messages ?? []).length);
    emit({ type: "text-delta", port: "text", textDelta: "ok" });
    emit({ type: "finish", data: {} });
  };
  return { sizes, runFn };
}

function scriptedIo(lines: readonly string[]): { io: AgentChatIo; out: () => string } {
  let index = 0;
  const written: string[] = [];
  return {
    io: {
      ask: async () => lines[index++],
      write: (text) => written.push(text),
    },
    out: () => written.join(""),
  };
}

describe("agent chat loop", () => {
  beforeEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
  });

  afterEach(() => {
    getAiProviderRegistry().unregisterProvider(PROVIDER);
  });

  const baseOptions = {
    model: MODEL as unknown as string,
    tools: [],
    systemPrompt: undefined,
    maxRounds: undefined,
    approval: "never" as const,
  };

  it("runs a turn per message and prints the reply", async () => {
    const called = scriptModel(["Hello back."]);
    const { io, out } = scriptedIo(["hello", "/exit"]);

    await runAgentChat(baseOptions, io);

    expect(called()).toBe(1);
    expect(out()).toContain("Hello back.");
  });

  it("ends at end of input as well as on /exit", async () => {
    scriptModel(["…"]);
    const { io } = scriptedIo(["hello", undefined as unknown as string]);
    await expect(runAgentChat(baseOptions, io)).resolves.toBeUndefined();
  });

  it("carries the conversation forward, and /reset drops it", async () => {
    const { sizes, runFn } = historySizes();
    getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
    const { io } = scriptedIo(["one", "two", "/reset", "three", "/exit"]);

    await runAgentChat(baseOptions, io);

    // Turn 1 sends just the user message; turn 2 sends that turn plus this
    // one's; after /reset turn 3 is back to a single message.
    expect(sizes).toEqual([1, 3, 1]);
  });

  it("says what it can reach, and that it reaches nothing without --tools", async () => {
    scriptModel(["hi"]);
    const { io, out } = scriptedIo(["/exit"]);

    await runAgentChat(baseOptions, io);

    expect(out()).toContain("No tools");
  });

  it("keeps the session alive when a turn fails, and keeps the history", async () => {
    let calls = 0;
    const runFn: AiProviderRunFn = async (input, _model, _signal, emit) => {
      calls++;
      if (calls === 1) throw new Error("provider exploded");
      const messages = (input as { messages?: unknown[] }).messages ?? [];
      emit({ type: "text-delta", port: "text", textDelta: `saw ${messages.length}` });
      emit({ type: "finish", data: {} });
    };
    getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
    const { io, out } = scriptedIo(["boom", "again", "/exit"]);

    await runAgentChat(baseOptions, io);

    expect(out()).toContain("provider exploded");
    // A failed turn recorded nothing, so the next one is still the first
    // message the model ever sees.
    expect(out()).toContain("saw 1");
  });

  describe("under a run that reports to a parent process", () => {
    it("asks for the next message through the human connector", async () => {
      const asked: IHumanRequest[] = [];
      const registry = new ServiceRegistry(new Container());
      registry.registerInstance(HUMAN_CONNECTOR, {
        send: async (request: IHumanRequest) => {
          asked.push(request);
          return {
            requestId: request.requestId,
            action: "accept" as const,
            content: { message: "hello" },
            done: true,
          };
        },
      });

      const ask = askThroughConnector(registry, new AbortController().signal);

      expect(await ask()).toBe("hello");
      expect(asked).toHaveLength(1);
      expect(asked[0]!.kind).toBe("elicit");
      // The marker a renderer keys on to draw a composer rather than a field.
      expect(asked[0]!.contentSchema).toEqual(CHAT_MESSAGE_SCHEMA);
    });

    it("ends the session when the person closes the composer", async () => {
      const registry = new ServiceRegistry(new Container());
      registry.registerInstance(HUMAN_CONNECTOR, {
        // Carrying content on a decline is a connector misbehaving — libs says
        // only an accepted elicit answers with data — and the session must end
        // on the action rather than on whether anything came back with it.
        send: async (request: IHumanRequest) => ({
          requestId: request.requestId,
          action: "decline" as const,
          content: { message: "typed, then dismissed" },
          done: true,
        }),
      });

      // `undefined` is how the loop reads end-of-input, the same as Ctrl-D.
      expect(await askThroughConnector(registry, new AbortController().signal)()).toBeUndefined();
    });

    it("leaves the channel's own connector in place", () => {
      const parent = new ServiceRegistry(new Container());
      const installed = {
        send: async () => ({
          requestId: "x",
          action: "decline" as const,
          content: undefined,
          done: true,
        }),
      };
      parent.registerInstance(HUMAN_CONNECTOR, installed);

      // A console session's approvals have to reach the channel; a child
      // registry carrying an Ink prompt would answer nobody.
      expect(chatRegistry(parent, true)).toBe(parent);
      expect(chatRegistry(parent, true).get(HUMAN_CONNECTOR)).toBe(installed);
      // On a terminal it is the other way round: the session prompts itself.
      expect(chatRegistry(parent, false).get(HUMAN_CONNECTOR)).not.toBe(installed);
    });
  });

  it("answers /help without calling the model", async () => {
    const called = scriptModel(["never"]);
    const { io, out } = scriptedIo(["/help", "/exit"]);

    await runAgentChat(baseOptions, io);

    expect(called()).toBe(0);
    expect(out()).toContain("/reset");
  });
});
