/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentStep,
  AgentTaskInput,
  AgentTaskOutput,
  ChatMessage,
  ModelConfig,
} from "@workglow/ai";
import { AGENT_APPROVAL_OPT_OUT, AgentTask, measureHistoryForModel } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { globalServiceRegistry, ServiceRegistry } from "@workglow/util";
import { PROBED_COMMANDS, probeCommands } from "./environment";
import type { AgentRunOutcome, AgentRunSummary } from "./runSummary";
import { summarizeUsage, tallyTools, totalCost } from "./runSummary";
import { codingSystemPrompt } from "./systemPrompt";
import type { CodingToolContext } from "./tools/context";
import { createCodingTools } from "./tools/codingTools";

/**
 * Rounds a benchmark run gets unless told otherwise. AgentTask's own default
 * (8) is sized for a chat turn; a terminal task routinely takes dozens.
 */
export const DEFAULT_BENCH_MAX_ROUNDS = 100;
/**
 * Room for one full tool output (50KB) plus its truncation notice, so the
 * loop's own clamp never cuts a result the tool already sized.
 */
export const DEFAULT_BENCH_MAX_TOOL_RESULT_CHARS = 60_000;

/** One line of the run's event log. */
export type AgentRunEvent =
  | { readonly type: "start"; readonly at: string; readonly model: string; readonly cwd: string }
  | {
      readonly type: "tool-call";
      readonly at: string;
      readonly status: string;
      readonly id: string;
      readonly name: string | undefined;
      readonly input?: unknown;
      readonly result?: string | undefined;
    }
  | { readonly type: "round"; readonly at: string; readonly step: AgentStep }
  | { readonly type: "finish"; readonly at: string; readonly summary: AgentRunSummary };

/** The knobs a Harbor job passes through as agent kwargs, for ablations. */
export interface CodingAgentSettings {
  readonly maxRounds: number;
  readonly maxToolResultChars: number;
  readonly maxHistoryChars: number | undefined;
  readonly toolConcurrency: number | undefined;
  readonly maxTokens: number | undefined;
  readonly temperature: number | undefined;
  readonly maxDurationMs: number | undefined;
  readonly roundTimeoutMs: number | undefined;
  readonly maxRoundRetries: number | undefined;
  readonly systemPromptAppend: string | undefined;
  /** Ask for terse replies between tool calls. */
  readonly concise: boolean;
  /** Show the model its remaining time each round; needs maxDurationMs. */
  readonly announceTimeLeft: boolean;
  /** Sent once when the model first tries to finish; undefined sends none. */
  readonly reviewPrompt: string | undefined;
}

export interface CodingAgentRun {
  readonly instruction: string;
  /** `provider/model`, as reported. */
  readonly modelId: string;
  readonly model: ModelConfig;
  readonly tools: CodingToolContext;
  readonly settings: CodingAgentSettings;
  readonly signal: AbortSignal;
  /**
   * Stops the run outright this long after it starts, ending it as `budget`. The
   * loop's own `maxDurationMs` stops only between rounds, so a model call in
   * flight at the outer limit would run on until whatever runs the agent kills
   * it, and the summary and trajectory would never be written.
   */
  readonly stopAfterMs?: number | undefined;
  readonly onEvent?: ((event: AgentRunEvent) => void) | undefined;
}

export interface CodingAgentResult {
  readonly summary: AgentRunSummary;
  readonly messages: readonly ChatMessage[];
  readonly steps: readonly AgentStep[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimForLog(text: string | undefined, max = 4000): string | undefined {
  if (text === undefined || text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length} chars]`;
}

/**
 * One benchmark attempt: the instruction as the only user message, AgentTask
 * running the four coding tools until the model stops calling them, a limit
 * runs out, or it fails.
 *
 * The transcript is kept from the loop's own snapshots rather than from its
 * final output, so a run that dies mid-way — a context-window overflow is
 * the usual one — still leaves every round it completed on the record.
 */
export async function runCodingAgent(run: CodingAgentRun): Promise<CodingAgentResult> {
  const now = (): string => new Date().toISOString();
  const emit = (event: AgentRunEvent): void => run.onEvent?.(event);
  const startedAt = Date.now();
  emit({ type: "start", at: now(), model: run.modelId, cwd: run.tools.cwd });

  const registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
  // Headless: no person to approve a call, and every tool is a host function.
  registry.registerInstance(AGENT_APPROVAL_OPT_OUT, true);

  let messages: readonly ChatMessage[] = [];
  let steps: readonly AgentStep[] = [];
  let reportedRounds = 0;
  const reportRounds = (): void => {
    for (; reportedRounds < steps.length; reportedRounds++) {
      emit({ type: "round", at: now(), step: steps[reportedRounds]! });
    }
  };
  const task = new AgentTask();
  // Counted off the loop's own progress messages, since `steps` holds only the
  // rounds that settled: a round that exhausted its retries leaves no step, and
  // its attempts would otherwise be missing from the summary.
  let roundsStarted = 0;
  let retriesSeen = 0;
  const offProgress = task.subscribe("progress", (_progress, message) => {
    if (message === "Thinking") roundsStarted++;
    else if (message?.startsWith("Thinking (attempt ")) retriesSeen++;
  });
  const off = task.subscribe("stream_chunk", (event: StreamEvent) => {
    if (event.type === "snapshot") {
      const data = event.data as { messages?: ChatMessage[]; steps?: AgentStep[] };
      if (data.messages) messages = data.messages;
      if (data.steps) {
        steps = data.steps;
        reportRounds();
      }
    } else if (event.type === "tool-call") {
      const call = event as unknown as {
        status: string;
        toolCallId: string;
        name?: string;
        input?: unknown;
        result?: string;
      };
      emit({
        type: "tool-call",
        at: now(),
        status: call.status,
        id: call.toolCallId,
        name: call.name,
        ...(call.input === undefined ? {} : { input: call.input }),
        ...(call.result === undefined ? {} : { result: trimForLog(call.result) }),
      });
    }
  });

  const settings = run.settings;
  const input: AgentTaskInput = {
    model: run.model,
    prompt: run.instruction,
    systemPrompt:
      codingSystemPrompt({
        cwd: run.tools.cwd,
        platform: `${process.platform} ${process.arch}`,
        date: new Date().toISOString().slice(0, 10),
        concise: settings.concise,
        images: run.tools.images,
        commands: probeCommands(PROBED_COMMANDS, process.env.PATH ?? ""),
      }) + (settings.systemPromptAppend ? `\n\n${settings.systemPromptAppend}` : ""),
    tools: createCodingTools(run.tools),
    maxRounds: settings.maxRounds,
    maxToolResultChars: settings.maxToolResultChars,
    approval: "never",
    ...(settings.maxHistoryChars === undefined
      ? {}
      : { maxHistoryChars: settings.maxHistoryChars }),
    ...(settings.toolConcurrency === undefined
      ? {}
      : { toolConcurrency: settings.toolConcurrency }),
    ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.maxDurationMs === undefined ? {} : { maxDurationMs: settings.maxDurationMs }),
    ...(settings.announceTimeLeft && settings.maxDurationMs !== undefined
      ? { announceTimeLeft: true }
      : {}),
    ...(settings.reviewPrompt === undefined ? {} : { reviewPrompt: settings.reviewPrompt }),
    ...(settings.roundTimeoutMs === undefined ? {} : { roundTimeoutMs: settings.roundTimeoutMs }),
    ...(settings.maxRoundRetries === undefined
      ? {}
      : { maxRoundRetries: settings.maxRoundRetries }),
  };

  const stopper = new AbortController();
  let stoppedAtLimit = false;
  const stopAfterMs = run.stopAfterMs;
  const stopTimer =
    stopAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          stoppedAtLimit = true;
          stopper.abort(new Error(`stopped at the hard time limit of ${stopAfterMs} ms`));
        }, stopAfterMs);
  const signal = AbortSignal.any([run.signal, stopper.signal]);

  let outcome: AgentRunOutcome;
  let error: string | undefined;
  let finalText = "";
  let rounds = 0;
  try {
    const output = (await task.run(input, { registry, signal })) as AgentTaskOutput;
    messages = output.messages;
    steps = output.steps;
    outcome = output.stopReason;
    rounds = output.rounds;
    // Only a round that called no tool answered; the narration beside a call is
    // not an answer when the turn ran out of rounds or budget after it.
    const last = steps.at(-1);
    finalText = last !== undefined && last.tools.length === 0 ? last.text : "";
  } catch (caught) {
    outcome = stoppedAtLimit ? "budget" : run.signal.aborted ? "aborted" : "error";
    // The provider reports its own cancellation; the limit is the reason it ran into.
    error = errorText(stoppedAtLimit ? stopper.signal.reason : caught);
    rounds = Math.max(steps.length, roundsStarted);
  } finally {
    clearTimeout(stopTimer);
    off();
    offProgress();
  }
  // The last round, when it ends the turn without a call, is in the output
  // but was never in a snapshot.
  reportRounds();

  // A round that started and never settled (it failed, was stopped, or ended the
  // turn while waiting to retry) has no step, though its request may have been
  // billed. Its usage and cost are unknown, so the totals are reported as
  // incomplete rather than as the settled rounds' subtotal.
  const unsettled = rounds > steps.length;
  const usage = summarizeUsage(steps);
  const summary: AgentRunSummary = {
    harness: "workglow",
    model: run.modelId,
    outcome,
    error,
    rounds,
    retries: Math.max(
      retriesSeen,
      steps.reduce((sum, step) => sum + Math.max(0, step.attempts - 1), 0)
    ),
    durationMs: Date.now() - startedAt,
    modelMs: steps.reduce((sum, step) => sum + step.modelMs, 0),
    usage: unsettled ? { ...usage, unreportedRounds: usage.unreportedRounds + 1 } : usage,
    costUsd: unsettled ? undefined : totalCost(steps),
    tools: tallyTools(steps),
    finalHistoryChars: measureHistoryForModel(messages),
    finalText,
    settings: { ...settings },
  };
  emit({ type: "finish", at: now(), summary });
  return { summary, messages, steps };
}
