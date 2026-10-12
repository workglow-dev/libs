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
} from "@workglow/ai";
import { Container, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROVIDER = "mock-native-turn-provider";

const MODEL: ModelConfig = {
  model_id: "mock/native-1",
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
  readonly native?: { readonly provider: string; readonly payload: string };
}

/** A scripted model that may hand back its own turn, and records what each round was sent. */
function script(rounds: readonly Round[]): ToolCallingTaskInput[] {
  const seen: ToolCallingTaskInput[] = [];
  const runFn: AiProviderRunFn = async (input, _model, _signal, emit) => {
    const round = rounds[Math.min(seen.length, rounds.length - 1)]!;
    seen.push(input as ToolCallingTaskInput);
    if (round.reasoning)
      emit({ type: "text-delta", port: "reasoning", textDelta: round.reasoning });
    if (round.text) emit({ type: "text-delta", port: "text", textDelta: round.text });
    if (round.calls?.length) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...round.calls] });
    }
    if (round.native) {
      emit({ type: "object-delta", port: "nativeTurn", objectDelta: round.native });
    }
    emit({ type: "finish", data: {} });
  };
  getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
  return seen;
}

const look = {
  name: "look",
  description: "Look",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => "looked",
} as const;

describe("AgentTask native turn", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
    registry = new ServiceRegistry(new Container());
  });

  afterEach(() => {
    getAiProviderRegistry().unregisterProvider(PROVIDER);
  });

  it("keeps a round's native turn on its reply and sends it back next round", async () => {
    const seen = script([
      {
        calls: [{ id: "c1", name: "look", input: {} }],
        native: { provider: "mock", payload: '[{"kind":"reasoning","enc":"xyz"}]' },
      },
      { text: "done" },
    ]);
    const output = await new AgentTask().run(
      { model: MODEL, prompt: "?", tools: [look] },
      { registry }
    );
    const reply = output.messages.find((m) => m.role === "assistant")!;
    expect(reply.content[0]).toEqual({
      type: "reasoning",
      text: "",
      provider: "mock",
      payload: '[{"kind":"reasoning","enc":"xyz"}]',
    });
    const sent = (seen[1]!.messages as ChatMessage[]).find((m) => m.role === "assistant")!;
    expect(sent.content[0]).toEqual({
      type: "reasoning",
      text: "",
      provider: "mock",
      payload: '[{"kind":"reasoning","enc":"xyz"}]',
    });
  });

  it("carries text reasoning and the native turn on one block", async () => {
    script([
      {
        reasoning: "Plan.",
        calls: [{ id: "c1", name: "look", input: {} }],
        native: { provider: "mock", payload: "[]" },
      },
      { text: "done" },
    ]);
    const output = await new AgentTask().run(
      { model: MODEL, prompt: "?", tools: [look] },
      { registry }
    );
    const blocks = output.messages
      .find((m) => m.role === "assistant")!
      .content.filter((b) => b.type === "reasoning");
    expect(blocks).toEqual([{ type: "reasoning", text: "Plan.", provider: "mock", payload: "[]" }]);
  });

  it("records no native turn on a reply that has neither text nor calls", async () => {
    script([{ native: { provider: "mock", payload: "[]" } }]);
    const output = await new AgentTask().run(
      { model: MODEL, prompt: "?", tools: [] },
      { registry }
    );
    expect(output.messages.filter((m) => m.role === "assistant")).toEqual([]);
  });
});
