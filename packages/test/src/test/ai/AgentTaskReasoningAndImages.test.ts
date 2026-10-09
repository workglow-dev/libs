/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ChatMessage, ModelConfig, ToolCallingTaskInput } from "@workglow/ai";
import {
  AgentTask,
  AiProviderRegistry,
  DirectExecutionStrategy,
  getAiProviderRegistry,
  setAiProviderRegistry,
  ToolResultContent,
} from "@workglow/ai";
import { RetryableJobError } from "@workglow/job-queue";
import { Container, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROVIDER = "mock-reasoning-provider";

const MODEL: ModelConfig = {
  model_id: "mock/reasoning-1",
  provider: PROVIDER,
  title: "",
  description: "",
  capabilities: ["tool-use"],
  provider_config: {},
  metadata: {},
};

interface Round {
  readonly reasoning?: string;
  readonly text?: string;
  readonly calls?: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Streamed, then thrown instead of answering, as a provider failing mid-stream does. */
  readonly failWith?: {
    readonly error: Error;
    readonly reasoning?: string;
    readonly text?: string;
  };
}

/** A scripted model that streams reasoning beside its reply, and records what each round was sent. */
function script(rounds: readonly Round[]): ToolCallingTaskInput[] {
  const seen: ToolCallingTaskInput[] = [];
  const runFn: AiProviderRunFn = async (input, _model, _signal, emit) => {
    const round = rounds[Math.min(seen.length, rounds.length - 1)]!;
    seen.push(input as ToolCallingTaskInput);
    if (round.failWith) {
      const { error, reasoning, text } = round.failWith;
      if (reasoning) emit({ type: "text-delta", port: "reasoning", textDelta: reasoning });
      if (text) emit({ type: "text-delta", port: "text", textDelta: text });
      throw error;
    }
    if (round.reasoning)
      emit({ type: "text-delta", port: "reasoning", textDelta: round.reasoning });
    if (round.text) emit({ type: "text-delta", port: "text", textDelta: round.text });
    if (round.calls?.length) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...round.calls] });
    }
    emit({ type: "finish", data: {} });
  };
  getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
  return seen;
}

describe("AgentTask reasoning and tool images", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
    registry = new ServiceRegistry(new Container());
  });

  afterEach(() => {
    getAiProviderRegistry().unregisterProvider(PROVIDER);
  });

  it("keeps a round's reasoning on its reply, so the next round is sent it", async () => {
    const seen = script([
      {
        reasoning: "The file is the place to start.",
        calls: [{ id: "c1", name: "look", input: {} }],
      },
      { reasoning: "Done thinking.", text: "It is fine." },
    ]);
    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "Check it",
        tools: [
          {
            name: "look",
            description: "Look",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => "looked",
          },
        ],
      },
      { registry }
    );

    const replies = output.messages.filter((message) => message.role === "assistant");
    expect(replies[0]!.content[0]).toEqual({
      type: "reasoning",
      text: "The file is the place to start.",
    });
    expect(replies[1]!.content).toEqual([
      { type: "reasoning", text: "Done thinking." },
      { type: "text", text: "It is fine." },
    ]);
    // The second round was sent the first round's reasoning with its call.
    const sentReply = (seen[1]!.messages as ChatMessage[]).find((m) => m.role === "assistant");
    expect(sentReply!.content.map((block) => block.type)).toEqual(["reasoning", "tool_use"]);
    // Reasoning is not part of what the turn said.
    expect(output.text).toBe("It is fine.");
  });

  it("records no reply for a round that only reasoned", async () => {
    script([{ reasoning: "Hmm." }]);
    const output = await new AgentTask().run(
      { model: MODEL, prompt: "Say nothing", tools: [] },
      { registry }
    );
    expect(output.messages.filter((message) => message.role === "assistant")).toEqual([]);
  });

  it("hands the model an image a tool returned through ToolResultContent", async () => {
    const seen = script([
      { calls: [{ id: "c1", name: "snap", input: {} }] },
      { text: "I see a board." },
    ]);
    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "What is in the picture?",
        tools: [
          {
            name: "snap",
            description: "Take a picture",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () =>
              new ToolResultContent([
                { type: "text", text: "Image: board.png" },
                { type: "image", mimeType: "image/png", data: "AAAA" },
              ]),
          },
        ],
      },
      { registry }
    );

    const result = output.messages.find((message) => message.role === "tool")!.content[0]!;
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "Image: board.png" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
      is_error: undefined,
    });
    const sentTool = (seen[1]!.messages as ChatMessage[]).find((m) => m.role === "tool")!;
    expect(JSON.stringify(sentTool)).toContain('"type":"image"');
    // The step record counts the text the model read, not the image bytes.
    expect(output.steps[0]!.tools[0]!.chars).toBe("Image: board.png".length);
  });

  describe("reasoning on the turn's own port", () => {
    const LOOK = {
      name: "look",
      description: "Look",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => "looked",
    } as const;

    function listen(task: AgentTask): Array<{ port: string; delta: string }> {
      const events: Array<{ port: string; delta: string }> = [];
      task.subscribe("stream_chunk", (event) => {
        if (event.type === "text-delta") {
          events.push({ port: event.port ?? "text", delta: event.textDelta });
        }
      });
      return events;
    }

    it("streams a round's reasoning on its own port, apart from the text", async () => {
      script([
        { reasoning: "Check the file first.", calls: [{ id: "c1", name: "look", input: {} }] },
        { reasoning: "It looks fine.", text: "All good." },
      ]);
      const task = new AgentTask();
      const events = listen(task);

      const output = await task.run(
        { model: MODEL, prompt: "Check it", tools: [LOOK], approval: "never" },
        { registry }
      );

      expect(events.filter((event) => event.port === "reasoning").map((e) => e.delta)).toEqual([
        "Check the file first.",
        // A round's reasoning is told from the one before it.
        "\n\n",
        "It looks fine.",
      ]);
      expect(events.filter((event) => event.port === "text").map((e) => e.delta)).toEqual([
        "All good.",
      ]);
      expect(output.reasoning).toBe("Check the file first.\n\nIt looks fine.");
      expect(output.text).toBe("All good.");
    });

    it("leaves reasoning off the output when the model streamed none", async () => {
      script([{ text: "Plain answer." }]);
      const task = new AgentTask();
      const events = listen(task);

      const output = await task.run(
        { model: MODEL, prompt: "Hi", tools: [], approval: "never" },
        { registry }
      );

      expect(events.some((event) => event.port === "reasoning")).toBe(false);
      expect(output.reasoning).toBeUndefined();
      expect("reasoning" in output).toBe(false);
      expect(output.text).toBe("Plain answer.");
    });

    it("does not separate a round that reasoned from one before it that did not", async () => {
      script([
        { calls: [{ id: "c1", name: "look", input: {} }] },
        { reasoning: "Only now.", text: "Done." },
      ]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "Check it", tools: [LOOK], approval: "never" },
        { registry }
      );
      expect(output.reasoning).toBe("Only now.");
    });

    it("drops a failed attempt's reasoning and text, so the retry's are not joined to them", async () => {
      script([
        {
          failWith: {
            error: new RetryableJobError("overloaded", new Date(Date.now())),
            reasoning: "Half a thought",
            text: "Half an ans",
          },
        },
        { reasoning: "A whole thought.", text: "A whole answer." },
      ]);
      const task = new AgentTask();
      const events = listen(task);

      const output = await task.run(
        { model: MODEL, prompt: "?", tools: [], approval: "never" },
        { registry }
      );

      expect(output.steps[0]!.attempts).toBe(2);
      expect(output.reasoning).toBe("A whole thought.");
      expect(output.text).toBe("A whole answer.");
      expect(events).toEqual([
        { port: "reasoning", delta: "A whole thought." },
        { port: "text", delta: "A whole answer." },
      ]);
    });
  });
});
