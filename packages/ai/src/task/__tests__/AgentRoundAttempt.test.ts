/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import type { IExecuteContext, StreamTextDelta, StreamTextRetract } from "@workglow/task-graph";
import { retractText } from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import { describe, expect, it } from "vitest";
import type { AgentRoundOptions, SettledRound } from "../AgentRoundAttempt";
import { REASONING_ROUND_SEPARATOR, settleRound } from "../AgentRoundAttempt";
import type { AgentRoundContext } from "../AgentRoundRunner";
import { AGENT_ROUND_RUNNER } from "../AgentRoundRunner";
import type { ToolCallingTaskInput, ToolCallingTaskOutput } from "../ToolCallingTask";

/** What one model call does: stream, then answer or throw. */
type Call = (
  input: ToolCallingTaskInput,
  round: AgentRoundContext
) => Promise<ToolCallingTaskOutput>;

const ANSWER: ToolCallingTaskOutput = { text: "done", toolCalls: [] };

/** A context whose rounds go to a host runner playing `calls` in order, the last repeating. */
function contextFor(calls: readonly Call[]): {
  readonly context: IExecuteContext;
  readonly called: () => number;
  readonly progress: string[];
} {
  let called = 0;
  const progress: string[] = [];
  const registry = new ServiceRegistry(new Container());
  registry.registerInstance(AGENT_ROUND_RUNNER, (input, round) => {
    const call = calls[Math.min(called, calls.length - 1)]!;
    called++;
    return call(input, round);
  });
  const context = {
    registry,
    signal: new AbortController().signal,
    updateProgress: async (_progress: number | undefined, message: string | undefined) => {
      if (message) progress.push(message);
    },
    own: () => {
      throw new Error("a round sent to a host runner owns nothing");
    },
  } as unknown as IExecuteContext;
  return { context, called: () => called, progress };
}

function options(
  context: IExecuteContext,
  overrides: Partial<AgentRoundOptions> = {}
): AgentRoundOptions {
  return {
    round: 1,
    turn: { model: "mock/model", prompt: "?", tools: [] },
    messages: [{ role: "user", content: [{ type: "text", text: "?" }] }],
    turnStart: 0,
    maxHistoryChars: 100_000,
    context,
    timeoutMs: undefined,
    maxRetries: 2,
    reasonedBefore: false,
    timeExhausted: () => false,
    ...overrides,
  };
}

type RoundEvent = StreamTextDelta | StreamTextRetract;

/** Folds one port of a round's events the way the stream does, retractions included. */
function folded(events: readonly RoundEvent[], port: string): string {
  let text = "";
  for (const event of events) {
    if (event.port !== port) continue;
    text = event.type === "text-retract" ? retractText(text, event.length) : text + event.textDelta;
  }
  return text;
}

/** Drains a round, returning what it forwarded and how it settled. */
async function drain(
  run: AsyncGenerator<RoundEvent, SettledRound, undefined>
): Promise<{ readonly events: RoundEvent[]; readonly settled: SettledRound }> {
  const events: RoundEvent[] = [];
  for (;;) {
    const next = await run.next();
    if (next.done) return { events, settled: next.value };
    events.push(next.value);
  }
}

describe("settleRound", () => {
  it("forwards the round's text and settles with its output", async () => {
    const { context, called } = contextFor([
      async (_input, round) => {
        round.onTextDelta("do");
        round.onTextDelta("ne");
        return ANSWER;
      },
    ]);
    const { events, settled } = await drain(settleRound(options(context)));
    expect(called()).toBe(1);
    expect(events).toEqual([
      { type: "text-delta", port: "text", textDelta: "do" },
      { type: "text-delta", port: "text", textDelta: "ne" },
    ]);
    expect(settled).toEqual({ status: "settled", output: ANSWER, attempts: 1 });
  });

  it("sends the round the history and the turn's own fields", async () => {
    let sent: ToolCallingTaskInput | undefined;
    const { context } = contextFor([
      async (input) => {
        sent = input;
        return ANSWER;
      },
    ]);
    await drain(
      settleRound(options(context, { turn: { model: "m", prompt: "p", tools: [], maxTokens: 9 } }))
    );
    expect(sent).toMatchObject({ model: "m", prompt: "p", maxTokens: 9 });
    expect(sent?.messages).toHaveLength(1);
  });

  it("retries a retryable failure and takes back the failed attempt's partial text", async () => {
    const { context, called, progress } = contextFor([
      async (_input, round) => {
        round.onTextDelta("half an ans");
        // Retry at once, as the provider asks: the wait is held to its one-second floor.
        throw new RetryableJobError("overloaded", new Date());
      },
      async (_input, round) => {
        round.onTextDelta("done");
        return ANSWER;
      },
    ]);
    const { events, settled } = await drain(settleRound(options(context)));
    expect(called()).toBe(2);
    // The partial is forwarded as it streams, then retracted before the retry,
    // so the folded port holds only the retry's text.
    expect(events).toEqual([
      { type: "text-delta", port: "text", textDelta: "half an ans" },
      { type: "text-retract", port: "text", length: "half an ans".length },
      { type: "text-delta", port: "text", textDelta: "done" },
    ]);
    expect(folded(events, "text")).toBe("done");
    expect(settled).toMatchObject({ status: "settled", attempts: 2 });
    expect(progress).toEqual(["Retrying in 1s", "Thinking (attempt 2)"]);
  });

  it("abandons the call in flight when the consumer stops reading", async () => {
    let signal: AbortSignal | undefined;
    const { context } = contextFor([
      async (_input, round) => {
        signal = round.signal;
        round.onTextDelta("partial");
        await new Promise<void>((resolve) =>
          round.signal.addEventListener("abort", () => resolve())
        );
        throw new Error("aborted");
      },
    ]);
    const run = settleRound(options(context));
    expect((await run.next()).value).toEqual({
      type: "text-delta",
      port: "text",
      textDelta: "partial",
    });
    expect(signal?.aborted).toBe(false);
    await run.return({ status: "out-of-time" });
    expect(signal?.aborted).toBe(true);
  });

  it("ends out of time rather than sleeping through a wait that passes the deadline", async () => {
    const { context, called, progress } = contextFor([
      async () => {
        throw new RetryableJobError("overloaded");
      },
    ]);
    const { settled } = await drain(
      settleRound(options(context, { timeExhausted: (at) => at !== undefined }))
    );
    expect(settled).toEqual({ status: "out-of-time" });
    expect(called()).toBe(1);
    expect(progress).toEqual([]);
  });

  it("throws a permanent failure, and a retryable one once retries are spent", async () => {
    const permanent = contextFor([
      async () => {
        throw new PermanentJobError("bad request");
      },
    ]);
    await expect(drain(settleRound(options(permanent.context)))).rejects.toBeInstanceOf(
      PermanentJobError
    );
    expect(permanent.called()).toBe(1);

    const retryable = contextFor([
      async () => {
        throw new RetryableJobError("overloaded");
      },
    ]);
    await expect(
      drain(settleRound(options(retryable.context, { maxRetries: 0 })))
    ).rejects.toBeInstanceOf(RetryableJobError);
    expect(retryable.called()).toBe(1);
  });

  it("abandons a call with no answer after timeoutMs as a retryable failure", async () => {
    const { context } = contextFor([
      (_input, round) =>
        new Promise<never>((_resolve, reject) => {
          round.signal.addEventListener("abort", () => reject(round.signal.reason), {
            once: true,
          });
        }),
    ]);
    await expect(
      drain(settleRound(options(context, { timeoutMs: 10, maxRetries: 0 })))
    ).rejects.toThrow(/Round 1 had no answer within 10 ms/);
  });

  it("sets a round's reasoning apart from an earlier round's, once it has some", async () => {
    const { context } = contextFor([
      async (_input, round) => {
        round.onReasoningDelta("");
        round.onReasoningDelta("think");
        round.onTextDelta("done");
        return ANSWER;
      },
    ]);
    const { events } = await drain(settleRound(options(context, { reasonedBefore: true })));
    expect(events).toEqual([
      { type: "text-delta", port: "reasoning", textDelta: REASONING_ROUND_SEPARATOR },
      { type: "text-delta", port: "reasoning", textDelta: "think" },
      { type: "text-delta", port: "text", textDelta: "done" },
    ]);
  });
});
