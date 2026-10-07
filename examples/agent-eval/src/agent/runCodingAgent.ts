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
import { AGENT_APPROVAL_OPT_OUT, AgentTask } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { globalServiceRegistry, ServiceRegistry } from "@workglow/util";
import type { AgentRunOutcome, AgentRunSummary } from "./runSummary";
import { historyChars, summarizeUsage, tallyTools, totalCost } from "./runSummary";
import { codingSystemPrompt } from "./systemPrompt";
import type { CodingToolContext } from "./tools/context";
import { createCodingTools } from "./tools/index";

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
}

export interface CodingAgentRun {
  readonly instruction: string;
  /** `provider/model`, as reported. */
  readonly modelId: string;
  readonly model: ModelConfig;
  readonly tools: CodingToolContext;
  readonly settings: CodingAgentSettings;
  readonly signal: AbortSignal;
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
    ...(settings.roundTimeoutMs === undefined ? {} : { roundTimeoutMs: settings.roundTimeoutMs }),
    ...(settings.maxRoundRetries === undefined
      ? {}
      : { maxRoundRetries: settings.maxRoundRetries }),
  };

  let outcome: AgentRunOutcome;
  let error: string | undefined;
  let finalText = "";
  let rounds = 0;
  try {
    const output = (await task.run(input, { registry, signal: run.signal })) as AgentTaskOutput;
    messages = output.messages;
    steps = output.steps;
    outcome = output.stopReason;
    rounds = output.rounds;
    finalText = steps.at(-1)?.text ?? "";
  } catch (caught) {
    outcome = run.signal.aborted ? "aborted" : "error";
    error = errorText(caught);
    rounds = steps.length;
  } finally {
    off();
  }
  // The last round, when it ends the turn without a call, is in the output
  // but was never in a snapshot.
  reportRounds();

  const summary: AgentRunSummary = {
    harness: "workglow",
    model: run.modelId,
    outcome,
    error,
    rounds,
    retries: steps.reduce((sum, step) => sum + Math.max(0, step.attempts - 1), 0),
    durationMs: Date.now() - startedAt,
    modelMs: steps.reduce((sum, step) => sum + step.modelMs, 0),
    usage: summarizeUsage(steps),
    costUsd: totalCost(steps),
    tools: tallyTools(steps),
    finalHistoryChars: historyChars(messages),
    finalText,
    settings: { ...settings },
  };
  emit({ type: "finish", at: now(), summary });
  return { summary, messages, steps };
}
