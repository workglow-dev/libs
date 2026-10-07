/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ModelConfig,
  ToolCallingTaskInput,
  ToolDefinition,
} from "@workglow/ai";
import {
  AgentTask,
  AiProviderRegistry,
  DirectExecutionStrategy,
  getAiProviderRegistry,
  setAiProviderRegistry,
} from "@workglow/ai";
import { Container, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROVIDER = "mock-deadline-provider";

const MODEL: ModelConfig = {
  model_id: "mock/deadline-1",
  provider: PROVIDER,
  title: "",
  description: "",
  capabilities: ["tool-use"],
  provider_config: {},
  metadata: {},
};

interface Round {
  readonly text?: string;
  readonly calls?: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
}

/** A scripted model, one entry per call with the last repeating; returns what each call was sent. */
function script(rounds: readonly Round[]): ToolCallingTaskInput[] {
  const seen: ToolCallingTaskInput[] = [];
  const runFn: AiProviderRunFn = async (input, _model, _signal, emit) => {
    const round = rounds[Math.min(seen.length, rounds.length - 1)]!;
    seen.push(input as ToolCallingTaskInput);
    if (round.text) emit({ type: "text-delta", port: "text", textDelta: round.text });
    if (round.calls?.length) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...round.calls] });
    }
    emit({ type: "finish", data: {} });
  };
  getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
  return seen;
}

const EMPTY = { type: "object", properties: {}, additionalProperties: false } as const;

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { name, description: name, inputSchema: EMPTY, execute };
}

describe("AgentTask deadline", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
    registry = new ServiceRegistry(new Container());
  });

  afterEach(() => {
    getAiProviderRegistry().unregisterProvider(PROVIDER);
  });

  it("hands a tool the moment the turn's time budget runs out", async () => {
    script([{ calls: [{ id: "c1", name: "clock", input: {} }] }, { text: "done" }]);
    const seen: Array<number | undefined> = [];
    const before = Date.now();
    await new AgentTask().run(
      {
        model: MODEL,
        prompt: "?",
        maxDurationMs: 60_000,
        tools: [
          tool("clock", async (_input, context) => {
            seen.push(context.deadline);
            return "ok";
          }),
        ],
      },
      { registry }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen[0]).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("hands no deadline on a turn with no time budget", async () => {
    script([{ calls: [{ id: "c1", name: "clock", input: {} }] }, { text: "done" }]);
    const seen: Array<number | undefined> = [];
    await new AgentTask().run(
      {
        model: MODEL,
        prompt: "?",
        tools: [
          tool("clock", async (_input, context) => {
            seen.push(context.deadline);
            return "ok";
          }),
        ],
      },
      { registry }
    );
    expect(seen).toEqual([undefined]);
  });
});
