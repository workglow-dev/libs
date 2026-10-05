/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelConfig, ToolDefinition } from "@workglow/ai";
import {
  AGENT_SUBMIT_TOOL_NAME,
  AgentTask,
  AiProviderRegistry,
  DirectExecutionStrategy,
  getAiProviderRegistry,
  retryDelayMs,
  setAiProviderRegistry,
} from "@workglow/ai";
import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import type { Usage } from "@workglow/task-graph";
import { TaskConfigurationError } from "@workglow/task-graph";
import type { IHumanConnector } from "@workglow/util";
import { Container, HUMAN_CONNECTOR, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROVIDER = "mock-agent-turn-controls";

const MODEL: ModelConfig = {
  model_id: "mock/turn-controls",
  provider: PROVIDER,
  title: "",
  description: "",
  capabilities: ["tool-use"],
  provider_config: {},
  metadata: {},
};

/** $1 per million uncached input tokens, 10c cached, $2 output: round numbers to check sums against. */
const PRICED_MODEL: ModelConfig = {
  ...MODEL,
  pricing: { currency: "USD", input: 1, cached: 0.1, output: 2 },
} as ModelConfig;

interface Round {
  readonly text?: string;
  readonly calls?: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
  readonly usage?: Usage;
  /** Thrown instead of answering. */
  readonly error?: Error;
  /** Streamed before `error` is thrown, as a provider failing mid-stream does. */
  readonly partial?: string;
  /** Never answers: waits until the call is abandoned. */
  readonly hang?: boolean;
}

function usage(input: number, cached: number, output: number): Usage {
  return {
    input,
    cached,
    output,
    cacheWrite: 0,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  };
}

/** One entry per model call, the last repeating. */
function script(rounds: readonly Round[]): () => number {
  let called = 0;
  const runFn: AiProviderRunFn = async (_input, _model, signal, emit) => {
    const round = rounds[Math.min(called, rounds.length - 1)]!;
    called++;
    if (round.error) {
      if (round.partial) emit({ type: "text-delta", port: "text", textDelta: round.partial });
      throw round.error;
    }
    if (round.hang) {
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (round.text) emit({ type: "text-delta", port: "text", textDelta: round.text });
    if (round.calls?.length) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...round.calls] });
    }
    emit({ type: "finish", data: {}, ...(round.usage ? { usage: round.usage } : {}) });
  };
  getAiProviderRegistry().registerRunFn(PROVIDER, { serves: ["tool-use"], runFn });
  return () => called;
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: { trust: { type: "integer" } },
  required: ["trust"],
  additionalProperties: false,
} as const;

/** A function tool that records how many of its calls overlap, and finishes in `ms`. */
function timedTool(
  name: string,
  ms: number,
  overlap: { active: number; peak: number },
  extra: Partial<ToolDefinition> = {}
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      overlap.active++;
      overlap.peak = Math.max(overlap.peak, overlap.active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      overlap.active--;
      return `${name} done`;
    },
    ...extra,
  };
}

const ECHO: ToolDefinition = {
  name: "echo",
  description: "Echoes",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  execute: async (input) => String((input as { text?: string }).text ?? ""),
};

function toolResults(messages: readonly { role: string; content: readonly unknown[] }[]) {
  return messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content as ReadonlyArray<Record<string, unknown>>);
}

describe("AgentTask turn controls", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
    registry = new ServiceRegistry(new Container());
  });

  afterEach(() => {
    getAiProviderRegistry().unregisterProvider(PROVIDER);
  });

  describe("outputSchema", () => {
    it("ends the turn on a submission that passes, after correcting one that did not", async () => {
      const called = script([
        { calls: [{ id: "s1", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: "lots" } }] },
        { calls: [{ id: "s2", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: 230 } }] },
      ]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], outputSchema: ANSWER_SCHEMA, approval: "never" },
        { registry }
      );
      expect(called()).toBe(2);
      expect(output.stopReason).toBe("submitted");
      expect(output.object).toEqual({ trust: 230 });
      const [rejected, accepted] = toolResults(output.messages);
      expect(rejected).toMatchObject({ tool_use_id: "s1", is_error: true });
      expect(JSON.stringify(rejected)).toContain("Answer rejected");
      expect(accepted).toMatchObject({ tool_use_id: "s2", is_error: undefined });
    });

    it("reminds a model that answered in text to submit", async () => {
      script([
        { text: "The trust holds 230." },
        { calls: [{ id: "s1", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: 230 } }] },
      ]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], outputSchema: ANSWER_SCHEMA, approval: "never" },
        { registry }
      );
      expect(output.stopReason).toBe("submitted");
      expect(output.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ]);
      expect(JSON.stringify(output.messages[2])).toContain(AGENT_SUBMIT_TOOL_NAME);
    });

    it("stops reminding after two, and reports the turn answered with no object", async () => {
      const called = script([{ text: "230." }]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], outputSchema: ANSWER_SCHEMA, approval: "never" },
        { registry }
      );
      expect(called()).toBe(3);
      expect(output.stopReason).toBe("answered");
      expect(output.object).toBeUndefined();
    });

    it("sends an answer back with checkSubmission's reason, and records the next", async () => {
      script([
        { calls: [{ id: "s1", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: 0 } }] },
        { calls: [{ id: "s2", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: 230 } }] },
      ]);
      const seen: number[] = [];
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [],
          outputSchema: ANSWER_SCHEMA,
          approval: "never",
          checkSubmission: (answer, turn) => {
            seen.push(turn.messages.length);
            return (answer as { trust: number }).trust === 0
              ? "The trust section states the amount; read it."
              : undefined;
          },
        },
        { registry }
      );
      expect(output.stopReason).toBe("submitted");
      expect(output.object).toEqual({ trust: 230 });
      expect(output.submissionRejections).toEqual([
        "The trust section states the amount; read it.",
      ]);
      const [rejected] = toolResults(output.messages);
      expect(rejected).toMatchObject({ tool_use_id: "s1", is_error: true });
      expect(JSON.stringify(rejected)).toContain("read it.");
      // The check saw the transcript as it stood, the submitting call included.
      expect(seen[0]).toBeGreaterThanOrEqual(2);
    });

    it("accepts an answer after two rejections, whatever the check says", async () => {
      script([{ calls: [{ id: "s", name: AGENT_SUBMIT_TOOL_NAME, input: { trust: 1 } }] }]);
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [],
          outputSchema: ANSWER_SCHEMA,
          approval: "never",
          checkSubmission: () => "Still wrong.",
        },
        { registry }
      );
      expect(output.stopReason).toBe("submitted");
      expect(output.submissionRejections).toHaveLength(2);
      expect(output.rounds).toBe(3);
    });

    it("refuses a tool already named like the submit tool", async () => {
      script([{ text: "x" }]);
      await expect(
        new AgentTask().run(
          {
            model: MODEL,
            prompt: "?",
            tools: [{ ...ECHO, name: AGENT_SUBMIT_TOOL_NAME }],
            outputSchema: ANSWER_SCHEMA,
            approval: "never",
          },
          { registry }
        )
      ).rejects.toBeInstanceOf(TaskConfigurationError);
    });
  });

  describe("toolConcurrency", () => {
    const calls = [
      { id: "a", name: "slow", input: {} },
      { id: "b", name: "fast", input: {} },
    ];

    it("runs a round's calls at once, and returns their results in the order asked", async () => {
      script([{ calls }, { text: "done" }]);
      const overlap = { active: 0, peak: 0 };
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [timedTool("slow", 40, overlap), timedTool("fast", 5, overlap)],
          toolConcurrency: 2,
          approval: "never",
        },
        { registry }
      );
      expect(overlap.peak).toBe(2);
      expect(toolResults(output.messages).map((result) => result.tool_use_id)).toEqual(["a", "b"]);
      expect(output.steps[0]!.tools.map((tool) => tool.id)).toEqual(["a", "b"]);
    });

    it("runs them one at a time by default", async () => {
      script([{ calls }, { text: "done" }]);
      const overlap = { active: 0, peak: 0 };
      await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [timedTool("slow", 20, overlap), timedTool("fast", 5, overlap)],
          approval: "never",
        },
        { registry }
      );
      expect(overlap.peak).toBe(1);
    });

    it("runs a round one at a time when any of its calls is put to a person", async () => {
      script([{ calls }, { text: "done" }]);
      const approve: IHumanConnector = {
        send: async (request) => ({
          requestId: request.requestId,
          action: "accept",
          content: undefined,
          done: true,
        }),
      };
      registry.registerInstance(HUMAN_CONNECTOR, approve);
      const overlap = { active: 0, peak: 0 };
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [
            timedTool("slow", 20, overlap, { requiresApproval: true }),
            timedTool("fast", 5, overlap),
          ],
          toolConcurrency: 2,
        },
        { registry }
      );
      // Both ran: the approved one too, so the peak measures ordering, not a refusal.
      expect(toolResults(output.messages).map((result) => result.is_error)).toEqual([
        undefined,
        undefined,
      ]);
      expect(overlap.peak).toBe(1);
    });
  });

  describe("steps", () => {
    it("records each round's tools, usage and cost, and totals the cost", async () => {
      script([
        {
          calls: [{ id: "c1", name: "echo", input: { text: "hi" } }],
          usage: usage(1_000, 9_000, 100),
        },
        { text: "done", usage: usage(500, 10_000, 50) },
      ]);
      const output = await new AgentTask().run(
        { model: PRICED_MODEL, prompt: "?", tools: [ECHO], approval: "never" },
        { registry }
      );
      expect(output.steps).toHaveLength(2);
      const [first, second] = output.steps;
      expect(first).toMatchObject({
        round: 1,
        attempts: 1,
        tools: [{ id: "c1", name: "echo", isError: false, chars: 2 }],
      });
      expect(first!.usage?.input).toBe(1_000);
      // 1,000 × $1 + 9,000 × $0.10 + 100 × $2, per million.
      expect(first!.costUsd).toBeCloseTo(0.0021, 8);
      expect(second!.costUsd).toBeCloseTo(0.0016, 8);
      expect(output.costUsd).toBeCloseTo(0.0037, 8);
    });

    it("leaves the total cost out when a round's could not be priced", async () => {
      script([{ text: "done", usage: usage(10, 0, 1) }]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], approval: "never" },
        { registry }
      );
      expect(output.steps[0]!.costUsd).toBeUndefined();
      expect(output.costUsd).toBeUndefined();
    });
  });

  describe("budgets", () => {
    const forever: Round = {
      calls: [{ id: "c", name: "echo", input: { text: "again" } }],
      usage: usage(1_000, 0, 10),
    };

    it("stops on maxInputTokens once the rounds have spent it, with every call answered", async () => {
      const called = script([forever]);
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [ECHO],
          maxInputTokens: 1_500,
          maxRounds: 10,
          approval: "never",
        },
        { registry }
      );
      expect(called()).toBe(2);
      expect(output.stopReason).toBe("budget");
      const uses = output.messages.flatMap((message) =>
        message.content.filter((block) => block.type === "tool_use")
      );
      expect(toolResults(output.messages)).toHaveLength(uses.length);
    });

    it("stops on maxCostUsd", async () => {
      // 1,000 uncached tokens at $1 per million plus 10 output at $2: $0.00102 a round.
      const called = script([forever]);
      const output = await new AgentTask().run(
        {
          model: PRICED_MODEL,
          prompt: "?",
          tools: [ECHO],
          maxCostUsd: 0.0025,
          maxRounds: 10,
          approval: "never",
        },
        { registry }
      );
      expect(called()).toBe(3);
      expect(output.stopReason).toBe("budget");
    });

    it("refuses maxCostUsd for a model with no price card", async () => {
      script([forever]);
      await expect(
        new AgentTask().run(
          { model: MODEL, prompt: "?", tools: [ECHO], maxCostUsd: 1, approval: "never" },
          { registry }
        )
      ).rejects.toBeInstanceOf(TaskConfigurationError);
    });

    it("starts no round after maxDurationMs", async () => {
      const called = script([forever]);
      const slowEcho: ToolDefinition = {
        ...ECHO,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "late";
        },
      };
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "?",
          tools: [slowEcho],
          maxDurationMs: 20,
          maxRounds: 10,
          approval: "never",
        },
        { registry }
      );
      expect(called()).toBe(1);
      expect(output.stopReason).toBe("budget");
    });
  });

  describe("round retries", () => {
    it("retries a round after a retryable failure, and counts the attempt", async () => {
      const called = script([
        { error: new RetryableJobError("429 rate limited", new Date(Date.now())) },
        { text: "done" },
      ]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], approval: "never" },
        { registry }
      );
      expect(called()).toBe(2);
      expect(output.stopReason).toBe("answered");
      expect(output.steps[0]!.attempts).toBe(2);
    });

    it("does not duplicate a failed attempt's streamed text on the retry", async () => {
      script([
        { partial: "Hello ", error: new RetryableJobError("overloaded", new Date(Date.now())) },
        { text: "Hello world", usage: usage(10, 0, 2) },
      ]);
      const task = new AgentTask();
      let streamed = "";
      task.subscribe("stream_chunk", (event) => {
        if (event.type === "text-delta") streamed += event.textDelta;
      });
      const output = await task.run(
        { model: MODEL, prompt: "?", tools: [], approval: "never" },
        { registry }
      );
      expect(output.steps[0]!.attempts).toBe(2);
      expect(output.text).toBe("Hello world");
      expect(output.steps[0]!.text).toBe("Hello world");
      expect(streamed).toBe(output.text);
    });

    it("fails at once on a permanent failure, or when retries are off", async () => {
      const permanent = script([
        { error: new PermanentJobError("401 bad key") },
        { text: "never" },
      ]);
      await expect(
        new AgentTask().run(
          { model: MODEL, prompt: "?", tools: [], approval: "never" },
          { registry }
        )
      ).rejects.toThrow(/401/);
      expect(permanent()).toBe(1);

      getAiProviderRegistry().unregisterProvider(PROVIDER);
      const off = script([{ error: new RetryableJobError("429") }, { text: "never" }]);
      await expect(
        new AgentTask().run(
          { model: MODEL, prompt: "?", tools: [], maxRoundRetries: 0, approval: "never" },
          { registry }
        )
      ).rejects.toThrow(/429/);
      expect(off()).toBe(1);
    });

    it("abandons a round with no answer after roundTimeoutMs, and retries it", async () => {
      const called = script([{ hang: true }, { text: "done" }]);
      const output = await new AgentTask().run(
        { model: MODEL, prompt: "?", tools: [], roundTimeoutMs: 50, approval: "never" },
        { registry }
      );
      expect(called()).toBe(2);
      expect(output.stopReason).toBe("answered");
      expect(output.steps[0]!.attempts).toBe(2);
    });

    it("fails the turn on a round with no answer when retries are off", async () => {
      script([{ hang: true }]);
      await expect(
        new AgentTask().run(
          {
            model: MODEL,
            prompt: "?",
            tools: [],
            roundTimeoutMs: 50,
            maxRoundRetries: 0,
            approval: "never",
          },
          { registry }
        )
      ).rejects.toThrow(/no answer within 50 ms/);
    });

    it("waits as the provider asks, within a second and a minute", () => {
      const now = 1_000_000;
      expect(retryDelayMs(new RetryableJobError("x", new Date(now + 5_000)), 1, now)).toBe(5_000);
      expect(retryDelayMs(new RetryableJobError("x", new Date(now + 10)), 1, now)).toBe(1_000);
      expect(retryDelayMs(new RetryableJobError("x", new Date(now + 600_000)), 1, now)).toBe(
        60_000
      );
      expect(retryDelayMs(new RetryableJobError("x"), 1, now)).toBe(2_000);
      expect(retryDelayMs(new RetryableJobError("x"), 3, now)).toBe(8_000);
    });
  });
});
