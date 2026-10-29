/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { RetryableJobError } from "@workglow/job-queue";
import type {
  IExecuteContext,
  StreamEvent,
  StreamTextDelta,
  StreamTextRetract,
} from "@workglow/task-graph";
import { retractionLength } from "@workglow/task-graph";
import { createEmitQueue } from "../capability/emitQueue";
import type { AgentRoundRunner } from "./AgentRoundRunner";
import { AGENT_ROUND_RUNNER } from "./AgentRoundRunner";
import { isRetryableRoundError, retryDelayMs, sleepUnlessAborted } from "./AgentTurnRecord";
import { assertModelMeetsRequires } from "./base/AiTask";
import { normalizeHistoryForModel, trimHistoryForModel } from "./ChatHistory";
import type { ChatMessage } from "./ChatMessage";
import type { ToolCallingTaskInput, ToolCallingTaskOutput } from "./ToolCallingTask";
import { ToolCallingTask } from "./ToolCallingTask";

/** What a round puts on the turn's wire: its text and reasoning, and the retraction of a failed attempt's. */
type RoundStreamEvent = StreamTextDelta | StreamTextRetract;

/** Between two rounds' reasoning, which would otherwise run together into one thought. */
export const REASONING_ROUND_SEPARATOR = "\n\n";

/** What one round asks the model, besides the history. */
export type AgentRoundTurn = Omit<ToolCallingTaskInput, "messages">;

export interface AgentRoundOptions {
  /** 1-based, for the owned round task's title and the timeout's message. */
  readonly round: number;
  readonly turn: AgentRoundTurn;
  /** The whole conversation so far; trimmed to `maxHistoryChars` before it is sent. */
  readonly messages: readonly ChatMessage[];
  /** Where this turn's own messages begin, which trimming keeps whole. */
  readonly turnStart: number;
  readonly maxHistoryChars: number;
  readonly context: IExecuteContext;
  /** How long one model call may take before it is abandoned as a retryable failure. */
  readonly timeoutMs: number | undefined;
  /** Retries after a retryable failure, beyond the first attempt. */
  readonly maxRetries: number;
  /** Whether an earlier round already streamed reasoning, so this round's is set apart. */
  readonly reasonedBefore: boolean;
  /** Whether a model call may still start at a moment; see {@link AgentTurnBudget.timeExhausted}. */
  readonly timeExhausted: (at?: number) => boolean;
}

/**
 * How one round ended: settled with the model's output (undefined when it
 * returned nothing), or out of time between attempts — the turn's time ran out
 * before a retry could start, and nothing from the failed attempt was recorded.
 */
export type SettledRound =
  | {
      readonly status: "settled";
      readonly output: ToolCallingTaskOutput | undefined;
      /** Model calls the round took: 1, plus each retry. */
      readonly attempts: number;
    }
  | { readonly status: "out-of-time" };

/** The host's round runner, when it bound one on this run's registry. */
function roundRunnerOf(context: IExecuteContext): AgentRoundRunner | undefined {
  return context.registry.has(AGENT_ROUND_RUNNER)
    ? context.registry.get(AGENT_ROUND_RUNNER)
    : undefined;
}

/**
 * Runs one round's model call to a settled output, retrying a retryable
 * failure (a rate limit, an overload, a call abandoned after `timeoutMs`) up to
 * `maxRetries` times, waiting as the provider asks.
 *
 * Yields the round's text and reasoning as this task's own, as they arrive. A
 * failed attempt takes back exactly what it yielded with a `text-retract` per
 * port before the retry starts, so the folded ports read as if it never ran.
 */
export async function* settleRound(
  options: AgentRoundOptions
): AsyncGenerator<RoundStreamEvent, SettledRound, undefined> {
  const { context } = options;
  const captured: { output: ToolCallingTaskOutput | undefined } = { output: undefined };
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      yield* attemptRound(options, captured);
      return { status: "settled", output: captured.output, attempts };
    } catch (err) {
      if (attempts > options.maxRetries || !isRetryableRoundError(err)) throw err;
      context.signal.throwIfAborted();
      const wait = retryDelayMs(err, attempts);
      // Nothing from the failed attempt has been recorded, so the turn can end
      // here as cleanly as between rounds.
      if (options.timeExhausted(Date.now() + wait)) return { status: "out-of-time" };
      await context.updateProgress(undefined, `Retrying in ${Math.ceil(wait / 1000)}s`);
      await sleepUnlessAborted(wait, context.signal);
      // The wait can overrun (a slow progress write, a late timer); an attempt
      // started past the deadline is one the budget no longer covers.
      if (options.timeExhausted()) return { status: "out-of-time" };
      // Said as the attempt starts, not before the wait: a wait cut short
      // (the run stopped during it) is no attempt made.
      await context.updateProgress(undefined, `Thinking (attempt ${attempts + 1})`);
    }
  }
}

/**
 * One attempt at a round's model call, re-yielding its text and reasoning.
 *
 * Owned, so the round shows up under the agent task and inherits the registry,
 * the abort signal and the run's usage accounting. The child's `toolCalls`
 * deltas are deliberately NOT forwarded: the agent has no such port, and a
 * delta naming one would accumulate onto an output that does not exist.
 *
 * A host that bound {@link AGENT_ROUND_RUNNER} runs the round itself instead,
 * and nothing is owned: the round happens wherever the host sent it.
 */
async function* attemptRound(
  options: AgentRoundOptions,
  captured: { output: ToolCallingTaskOutput | undefined }
): AsyncGenerator<RoundStreamEvent, void, undefined> {
  const { round, turn, context, timeoutMs } = options;
  const roundInput: ToolCallingTaskInput = {
    model: turn.model,
    prompt: turn.prompt,
    systemPrompt: turn.systemPrompt,
    // The current turn is held whole: a reminder or review prompt is a user
    // message, and a cut there would drop the prompt the model is asked to
    // check its answer against and every tool result it gathered. Earlier
    // turns are still cut to fit.
    messages: normalizeHistoryForModel(
      trimHistoryForModel(options.messages, options.maxHistoryChars, options.turnStart)
    ),
    tools: turn.tools,
    temperature: turn.temperature,
    maxTokens: turn.maxTokens,
  };
  const hostRunner = roundRunnerOf(context);
  const queue = createEmitQueue<RoundStreamEvent>();
  let off = (): void => {};
  let runRound: () => Promise<ToolCallingTaskOutput>;
  // A round that never answers holds the turn forever: a provider can accept
  // a request and then send nothing back. Abandoning it as a retryable
  // failure hands it to the turn's round retries.
  const roundAbort = new AbortController();
  let abandon = (): void => roundAbort.abort();
  let timedOut = false;
  if (hostRunner) {
    // The owned ToolCallingTask gates the model before it dispatches; a round
    // handed elsewhere owes the same gate here, or a model that cannot use
    // tools would be sent a round that needs them. An unresolved id is left to
    // the far side, which resolves and gates it itself.
    if (typeof turn.model === "object") {
      assertModelMeetsRequires(turn.model, ToolCallingTask.requires, ToolCallingTask.type);
    }
    runRound = () =>
      hostRunner(roundInput, {
        signal: AbortSignal.any([context.signal, roundAbort.signal]),
        onTextDelta: (delta) => queue.push({ type: "text-delta", port: "text", textDelta: delta }),
        onReasoningDelta: (delta) =>
          queue.push({ type: "text-delta", port: "reasoning", textDelta: delta }),
        // Progress is advisory: a failed update must not surface as an
        // unhandled rejection, nor fail a round that is otherwise fine.
        onProgress: (progress, message) => {
          context.updateProgress(progress, message).catch(() => {});
        },
      });
  } else {
    const task = new ToolCallingTask({ title: `Round ${round}` });
    context.own(task);
    abandon = () => task.abort();
    off = task.subscribe("stream_chunk", (event: StreamEvent) => {
      if (event.type !== "text-delta" && event.type !== "text-retract") return;
      const port = event.port ?? "text";
      if (port !== "text" && port !== "reasoning") return;
      queue.push({ ...event, port });
    });
    runRound = () => task.run(roundInput);
  }
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          abandon();
        }, timeoutMs);
  let settled = false;
  const run = (async () => {
    try {
      captured.output = await runRound();
    } catch (err) {
      if (timedOut && !context.signal.aborted) {
        throw new RetryableJobError(`Round ${round} had no answer within ${timeoutMs} ms`);
      }
      throw err;
    } finally {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
      queue.close();
    }
  })();
  // Held so a rejection while the queue is still draining is not reported as
  // unhandled; it is re-thrown below, once the events already produced have
  // reached the caller.
  run.catch(() => {});
  // Forwarded as they arrive, so a host sees the reply as it is written. What
  // this attempt forwarded is counted per port, because the stream folds every
  // delta into the task's text and reasoning ports: an attempt that fails takes
  // exactly that much back with a `text-retract`, and a retry or the next round
  // appends after the earlier rounds as if it never ran.
  let textSent = 0;
  let reasoningSent = 0;
  // Rounds are told apart on the wire exactly as in the settled output, and
  // only once this round has something to say: a separator ahead of nothing
  // would leave the streamed reasoning ending differently than the final one.
  let separatorSent = false;
  try {
    for await (const event of queue.iterable) {
      if (event.type === "text-retract") {
        // Counted as the fold removes it: a NaN would poison the counters and a
        // fraction would drift them from the text, so a failed attempt's own
        // retraction would take back too little, or an earlier round's text.
        const requested = retractionLength(event.length);
        if (requested === 0) continue;
        if (event.port === "text") {
          const length = Math.min(requested, textSent);
          textSent -= length;
          if (length > 0) yield { type: "text-retract", port: "text", length };
        } else {
          let length = Math.min(requested, reasoningSent);
          reasoningSent -= length;
          // Everything this round reasoned was taken back, so the separator
          // ahead of it goes too.
          if (reasoningSent === 0 && separatorSent) {
            length += REASONING_ROUND_SEPARATOR.length;
            separatorSent = false;
          }
          if (length > 0) yield { type: "text-retract", port: "reasoning", length };
        }
        continue;
      }
      if (event.textDelta.length === 0) continue;
      if (event.port === "text") {
        textSent += event.textDelta.length;
      } else {
        if (options.reasonedBefore && !separatorSent) {
          yield { type: "text-delta", port: "reasoning", textDelta: REASONING_ROUND_SEPARATOR };
          separatorSent = true;
        }
        reasoningSent += event.textDelta.length;
      }
      yield event;
    }
    await run;
  } catch (err) {
    if (textSent > 0) yield { type: "text-retract", port: "text", length: textSent };
    const reasoningLength = reasoningSent + (separatorSent ? REASONING_ROUND_SEPARATOR.length : 0);
    if (reasoningLength > 0) {
      yield { type: "text-retract", port: "reasoning", length: reasoningLength };
    }
    throw err;
  } finally {
    // Deltas are yielded while the call is still running, so a consumer that
    // stops reading leaves this generator at a `yield` with the call in flight.
    // Abandoning it ends the request; the run's own `finally` then clears the
    // timer and the listener.
    if (!settled) abandon();
  }
}
