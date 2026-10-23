/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  StreamEvent,
  TaskConfig,
  TaskEntitlements,
  TaskOutput,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  Task,
  TaskConfigurationError,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema, JsonSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import { readUsage } from "../capability/UsageTelemetry";
import type { ModelConfig } from "../model/ModelSchema";
import { REASONING_ROUND_SEPARATOR, settleRound } from "./AgentRoundAttempt";
import type { AgentApprovalMode } from "./AgentToolExecution";
import { assistantMessage, isAnswerable, runToolRound } from "./AgentToolRound";
import { AgentTurnBudget } from "./AgentTurnBudget";
import { AgentTurnPolicy, MAX_SUBMISSION_REJECTIONS } from "./AgentTurnPolicy";
import type { AgentStep, AgentSubmissionCheck } from "./AgentTurnRecord";
import { AGENT_SUBMIT_TOOL_NAME, agentModelPricing } from "./AgentTurnRecord";
import { promptToUserMessage } from "./base/CheckpointPorts";
import { DEFAULT_MAX_HISTORY_CHARS } from "./ChatHistory";
import type { ChatMessage } from "./ChatMessage";
import { ChatMessageSchema } from "./ChatMessage";
import { collectToolUseIds, uniquifyToolCallIds } from "./ToolCallIds";
import type { ToolCallingTaskInput } from "./ToolCallingTask";
import { ToolCallingInputSchema } from "./ToolCallingTask";
import type { ToolDefinition } from "./ToolCallingUtils";
import { compileToolValidators } from "./ToolCallingUtils";

/** Rounds before the loop gives up on the model reaching an answer. */
const DEFAULT_MAX_ROUNDS = 8;

/**
 * Characters of one tool's output the model is shown.
 *
 * A single unbounded result — a fetched page, a table dump — is the ordinary
 * way an agent turn dies: it fills the window, and every later round is spent
 * re-sending it. Truncation is marked in the text so the model can tell it is
 * reading a prefix and ask for less next time.
 */
const DEFAULT_MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * Retries of one round's model call after a retryable failure — a rate limit,
 * an overloaded provider, a timeout. A turn several rounds in has already paid
 * for those rounds, and failing it for one 429 throws them away.
 */
const DEFAULT_MAX_ROUND_RETRIES = 2;

export const AgentInputSchema = {
  type: "object",
  properties: {
    model: ToolCallingInputSchema.properties.model,
    prompt: ToolCallingInputSchema.properties.prompt,
    systemPrompt: ToolCallingInputSchema.properties.systemPrompt,
    messages: {
      ...ToolCallingInputSchema.properties.messages,
      description:
        "Conversation history BEFORE this turn. The prompt is appended to it as the user message, and the whole thing comes back on the messages output.",
    },
    tools: ToolCallingInputSchema.properties.tools,
    temperature: ToolCallingInputSchema.properties.temperature,
    maxTokens: ToolCallingInputSchema.properties.maxTokens,
    maxRounds: {
      type: "integer",
      title: "Max Rounds",
      description:
        "Model calls before the turn ends unanswered. One round is one model call plus every tool it asked for.",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    maxToolResultChars: {
      type: "integer",
      title: "Max Tool Result Characters",
      description: "Characters of a single tool's output the model is shown before truncation",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    maxHistoryChars: {
      type: "integer",
      title: "Max History Characters",
      description:
        "Character budget for the history sent to the model; older turns are dropped whole",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    outputSchema: {
      type: "object",
      title: "Output Schema",
      description: `JSON Schema of the answer. Given one, the turn adds a ${AGENT_SUBMIT_TOOL_NAME} tool taking it, ends on a call that passes it, and reports the answer on the object output`,
      additionalProperties: true,
      "x-ui-group": "Configuration",
    },
    checkSubmission: {
      title: "Check Submission",
      description: `A host function given an answer that passed outputSchema and the turn so far; a returned reason sends the answer back to the model to fix (at most ${MAX_SUBMISSION_REJECTIONS} times), undefined accepts it`,
      "x-ui-hidden": true,
    },
    roundTimeoutMs: {
      type: "integer",
      title: "Round Timeout (ms)",
      description:
        "Time one model call may take before it is abandoned and retried as a retryable failure",
      minimum: 1,
      // The longest timer that can be set; past it the round would be abandoned at once.
      maximum: 2_147_483_647,
      "x-ui-group": "Configuration",
    },
    toolConcurrency: {
      type: "integer",
      title: "Tool Concurrency",
      description:
        "Tool calls of one round run at once. Results return in the order the model asked; a round with a call that needs approval runs its calls one at a time",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    maxRoundRetries: {
      type: "integer",
      title: "Max Round Retries",
      description:
        "Times one round's model call is retried after a retryable failure (rate limit, overload, timeout), waiting as the provider asks",
      minimum: 0,
      "x-ui-group": "Configuration",
    },
    maxInputTokens: {
      type: "integer",
      title: "Max Input Tokens",
      description:
        "Prompt tokens, cached or not, summed over the turn's rounds, after which it stops with stopReason budget. An estimate counts like a stated figure. Fails closed: a round whose provider reported no prompt count cannot be counted, so the turn stops with stopReason budget after that round",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    maxCostUsd: {
      type: "number",
      title: "Max Cost (USD)",
      description:
        "Estimated spend after which the turn stops with stopReason budget. Needs a price card for the model. Fails closed: a round whose usage the provider did not report, or reported only as an estimate, cannot be priced, so the turn stops with stopReason budget after that round",
      exclusiveMinimum: 0,
      "x-ui-group": "Configuration",
    },
    maxDurationMs: {
      type: "integer",
      title: "Max Duration (ms)",
      description:
        "Wall-clock time after which no further round starts; the turn stops with stopReason budget",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    announceTimeLeft: {
      type: "boolean",
      title: "Announce Time Left",
      description:
        "Append the time left before maxDurationMs to the last tool result of every round, so the model can plan the work it has time for. Needs maxDurationMs",
      "x-ui-group": "Configuration",
    },
    reviewPrompt: {
      type: "string",
      title: "Review Prompt",
      description:
        "Sent once, as a user message, the first time the model replies without calling a tool, so it checks its work before the turn ends. Not sent on a turn with outputSchema, or when no round, budget or time is left to act on it",
      "x-ui-group": "Configuration",
    },
    approval: {
      type: "string",
      title: "Approval",
      description:
        'When a tool call is put to a person first: "beyond-inference" confirms any tool reaching past running a model, "never" confirms nothing. "never" needs the host to bind AGENT_APPROVAL_OPT_OUT; on its own it cannot take a confirmation away.',
      enum: ["beyond-inference", "never"],
      "x-ui-group": "Configuration",
    },
  },
  required: ["model", "prompt", "tools"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const AgentOutputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description:
        "Everything the assistant said this turn, including what it narrated between tool calls",
      "x-stream": "append",
    },
    reasoning: {
      type: "string",
      title: "Reasoning",
      description: "The model's reasoning this turn, as the provider streamed it",
      "x-stream": "append",
    },
    messages: {
      type: "array",
      items: ChatMessageSchema,
      title: "Messages",
      description:
        "The input history plus this turn: the user message, each assistant reply, and each round's tool results",
    },
    rounds: {
      type: "integer",
      title: "Rounds",
      description: "Model calls this turn took",
    },
    stopReason: {
      type: "string",
      title: "Stop Reason",
      description:
        '"answered" when the model replied without asking for a tool, "submitted" when it submitted an answer that passed outputSchema, "budget" when a token, cost or time budget ran out, "max-rounds" when it ran out of rounds first',
      enum: ["answered", "submitted", "budget", "max-rounds"],
    },
    object: {
      title: "Object",
      description:
        "The submitted answer, when the turn had an outputSchema and stopped as submitted",
    },
    steps: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      title: "Steps",
      description:
        "One record per round: when it started, how long the model call and the tools took, retries, each tool's outcome, usage and cost",
    },
    submissionRejections: {
      type: "array",
      items: { type: "string" },
      title: "Submission Rejections",
      description: "Each reason checkSubmission gave for sending an answer back, in order",
    },
    costUsd: {
      type: "number",
      title: "Cost (USD)",
      description:
        "Estimated spend of the turn, when every round reported usage and the model has a USD price card",
    },
  },
  required: ["text", "messages", "rounds", "stopReason", "steps", "submissionRejections"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

/**
 * Written out rather than derived from {@link AgentInputSchema}: the shared
 * ports carry `ToolCallingTask`'s `prompt`, whose `oneOf` costs more
 * type-instantiation budget through `FromSchema` than the whole task is worth.
 */
export type AgentTaskInput = {
  readonly model: string | ModelConfig;
  /** Taken from the round task rather than restated, so the two cannot drift. */
  readonly prompt: ToolCallingTaskInput["prompt"];
  readonly systemPrompt?: string | undefined;
  readonly messages?: ReadonlyArray<ChatMessage> | undefined;
  readonly tools: ToolDefinition[];
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxRounds?: number | undefined;
  readonly maxToolResultChars?: number | undefined;
  readonly maxHistoryChars?: number | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  readonly checkSubmission?: AgentSubmissionCheck | undefined;
  readonly roundTimeoutMs?: number | undefined;
  readonly toolConcurrency?: number | undefined;
  readonly maxRoundRetries?: number | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly announceTimeLeft?: boolean | undefined;
  readonly reviewPrompt?: string | undefined;
  readonly approval?: AgentApprovalMode | undefined;
};

export type AgentStopReason = "answered" | "submitted" | "budget" | "max-rounds";

export type AgentTaskOutput = {
  text: string;
  /**
   * Each round's reasoning, a blank line between rounds that reasoned. Absent
   * when no round returned any, so a turn against a model that does not think
   * has the output it always had.
   */
  reasoning?: string | undefined;
  messages: ChatMessage[];
  rounds: number;
  stopReason: AgentStopReason;
  /** Present when the turn stopped as `"submitted"`. */
  object?: unknown;
  steps: AgentStep[];
  /** Each reason `checkSubmission` gave for sending an answer back. */
  submissionRejections: string[];
  /** Absent when any round's cost could not be estimated. */
  costUsd?: number | undefined;
};

export type AgentTaskConfig = TaskConfig<AgentTaskInput>;

/**
 * One conversational turn: call the model, run every tool it asks for, feed the
 * results back, and repeat until it answers without tools.
 *
 * The loop is the part hosts get wrong, so it lives here rather than in each of
 * them. Three invariants it keeps:
 *
 * - **Every `tool_use` gets a `tool_result`.** An unknown tool, arguments that
 *   fail the tool's own schema, a throw inside the tool, a person declining it
 *   — each becomes an error result the model reads and can recover from.
 *   Dropping the call instead leaves an unanswered `tool_use` in the history,
 *   which providers reject on the next round, so the cheap-looking filter
 *   breaks the conversation one turn later.
 * - **Tool-call ids are unique across the whole conversation.** A model that
 *   restarts its numbering at `call_0` each turn would otherwise attach this
 *   turn's result to an earlier turn's call.
 * - **Tools run in order unless the host asks otherwise.** One may block on a
 *   person, and the next must not race ahead of the answer, so `toolConcurrency`
 *   is opt-in and a round holding a call that needs approval runs one at a time
 *   whatever it says. Results go back in the order the model asked either way.
 *
 * What it deliberately does NOT do is keep the conversation. `messages` comes
 * in and goes out, so the host owns the record — which is what lets the same
 * loop serve a chat transcript, a CLI session, and a graph node.
 */
export class AgentTask extends Task<AgentTaskInput, AgentTaskOutput, AgentTaskConfig> {
  public static override type = "AgentTask";
  /**
   * A statement about the model port, not a gate this class enforces: the model
   * is handed to a {@link ToolCallingTask} each round, and that is where the
   * capability is checked. Declared so a model picker filters the same way.
   */
  public static readonly requires = ["tool-use"] as const satisfies Capability[];
  public static override category = "AI Text";
  public static override title = "Agent";
  public static override description =
    "Runs a conversational turn to completion: calls a model, runs the tools it asks for, and feeds the results back until it answers";
  /** Tools have side effects and a person may have approved one; never replay a turn from cache. */
  public static override cachePolicy: CachePolicy = { kind: "none" };
  /**
   * The reach is in the tools, which arrive as an input and so are unknown
   * until the run. Saying so is what puts an approval in front of an agent
   * used as somebody else's tool.
   */
  public static override entitlementsFromChildren: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.AI_INFERENCE, reason: "Runs a model once per round" }],
    };
  }

  public static override inputSchema(): DataPortSchema {
    return AgentInputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return AgentOutputSchema as DataPortSchema;
  }

  async *executeStream(
    input: AgentTaskInput,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<AgentTaskOutput>> {
    const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const maxToolResultChars = input.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    const maxHistoryChars = input.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
    const maxRoundRetries = input.maxRoundRetries ?? DEFAULT_MAX_ROUND_RETRIES;
    const toolConcurrency = Math.max(1, input.toolConcurrency ?? 1);
    const approval: AgentApprovalMode = input.approval ?? "beyond-inference";

    const steps: AgentStep[] = [];
    const messages: ChatMessage[] = [...(input.messages ?? []), promptToUserMessage(input.prompt)];
    // Where this turn's own messages begin: the prompt, after the prior conversation.
    const turnStart = input.messages?.length ?? 0;
    const policy = new AgentTurnPolicy({
      maxRounds,
      outputSchema: input.outputSchema,
      checkSubmission: input.checkSubmission,
      reviewPrompt: input.reviewPrompt,
      announceTimeLeft: input.announceTimeLeft === true,
      // A check sees the transcript and step list as they stand when the model submits.
      turnSoFar: () => ({ messages, steps }),
    });
    const submitTool = policy.submitTool;
    if (submitTool !== undefined && input.tools.some((tool) => tool.name === submitTool.name)) {
      throw new TaskConfigurationError(
        `AgentTask: a tool named "${submitTool.name}" is reserved for submitting against outputSchema`
      );
    }
    const tools = submitTool === undefined ? input.tools : [...input.tools, submitTool];
    const validators = compileToolValidators(tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const roundTurn: AgentTaskInput = { ...input, tools };

    const budget = new AgentTurnBudget(
      {
        maxInputTokens: input.maxInputTokens,
        maxCostUsd: input.maxCostUsd,
        maxDurationMs: input.maxDurationMs,
      },
      await agentModelPricing(input.model, context.registry)
    );
    if (input.announceTimeLeft && input.maxDurationMs === undefined) {
      throw new TaskConfigurationError(
        "AgentTask: announceTimeLeft needs maxDurationMs, the budget it announces"
      );
    }

    /**
     * The transcript so far, for a host drawing one while the turn is still
     * running — a tool card wants to exist from the moment the model asks for
     * it, not once the turn is over. The step records ride along, so a host
     * persisting a turn round by round has each one as it settles.
     *
     * A `snapshot` rather than an `object-delta` on the `messages` port: an
     * object-delta carrying an array is folded as an upsert list, so successive
     * whole-list snapshots would append into a transcript several times its own
     * length. A snapshot reaches subscribers and touches no output port.
     */
    const transcript = (): StreamEvent<AgentTaskOutput> =>
      ({
        type: "snapshot",
        data: { messages: [...messages], steps: [...steps] },
      }) as StreamEvent<AgentTaskOutput>;
    let text = "";
    let reasoning = "";
    let rounds = 0;
    const finish = (stopReason: AgentStopReason): StreamEvent<AgentTaskOutput> => {
      const submitted = policy.submitted;
      const costUsd = budget.costUsd();
      return {
        type: "finish",
        data: {
          text,
          ...(reasoning.length > 0 ? { reasoning } : {}),
          messages,
          rounds,
          stopReason,
          steps,
          submissionRejections: policy.submissionRejections,
          ...(submitted === undefined ? {} : { object: submitted.value }),
          ...(costUsd === undefined ? {} : { costUsd }),
        },
      };
    };
    yield transcript();

    for (let round = 0; round < maxRounds; round++) {
      context.signal.throwIfAborted();
      if (budget.timeExhausted()) {
        yield finish("budget");
        return;
      }
      await context.updateProgress(undefined, "Thinking");
      // A slow progress write can carry the turn past its deadline, and a round
      // started there is a model call the budget no longer covers.
      if (budget.timeExhausted()) {
        yield finish("budget");
        return;
      }
      rounds = round + 1;
      const roundStart = Date.now();
      const settled = yield* settleRound({
        round: rounds,
        turn: roundTurn,
        messages,
        turnStart,
        maxHistoryChars,
        context,
        timeoutMs: input.roundTimeoutMs,
        maxRetries: maxRoundRetries,
        reasonedBefore: reasoning.length > 0,
        timeExhausted: (at) => budget.timeExhausted(at),
      });
      if (settled.status === "out-of-time") {
        yield finish("budget");
        return;
      }
      const { output, attempts } = settled;
      const modelMs = Date.now() - roundStart;
      const usage = readUsage(output as TaskOutput | undefined);
      const costUsd = budget.price(usage, new Date(roundStart));
      // Summed from the round's settled output rather than from the deltas just
      // forwarded: a provider that reports its text only on the finish event
      // streams nothing, and counting deltas would report an empty answer while
      // `messages` carried the real one.
      text += output?.text ?? "";
      const roundReasoning = output?.reasoning ?? "";
      if (roundReasoning.length > 0) {
        reasoning += (reasoning.length > 0 ? REASONING_ROUND_SEPARATOR : "") + roundReasoning;
      }

      const record = (toolRecords: AgentStep["tools"]): void => {
        steps.push({
          round: rounds,
          startedAt: new Date(roundStart).toISOString(),
          modelMs,
          durationMs: Date.now() - roundStart,
          attempts,
          text: output?.text ?? "",
          tools: toolRecords,
          usage,
          costUsd,
        });
        budget.record(usage, costUsd);
      };

      const calls = uniquifyToolCallIds(
        (output?.toolCalls ?? []).filter(isAnswerable),
        collectToolUseIds(messages)
      );
      // A turn with neither text nor a usable call records nothing: an empty
      // assistant message is not a reply, and providers reject a replayed
      // prefix containing one.
      const reply = assistantMessage(
        output?.text ?? "",
        calls,
        output?.reasoning,
        output?.nativeTurn
      );
      if (reply.content.length > 0) {
        messages.push(reply);
        yield transcript();
      }
      if (calls.length === 0) {
        record([]);
        const followUp = policy.followUp(round, budget);
        if (followUp !== undefined) {
          messages.push(followUp);
          yield transcript();
          continue;
        }
        yield finish(budget.exhausted() ? "budget" : "answered");
        return;
      }

      const { results, records } = yield* runToolRound(calls, context, {
        byName,
        validators,
        approval,
        concurrency: toolConcurrency,
        maxResultChars: maxToolResultChars,
        deadline: budget.deadline,
        submitToolName: submitTool?.name,
      });
      policy.announceTimeLeft(results, records, budget.deadline);
      messages.push({ role: "tool", content: results });
      record(records);
      yield transcript();
      if (policy.submitted !== undefined) {
        yield finish("submitted");
        return;
      }
      if (budget.mustStopLoop()) {
        yield finish("budget");
        return;
      }
    }

    yield finish("max-rounds");
  }
}

export const agent = (
  input: AgentTaskInput,
  config?: AgentTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new AgentTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    agent: CreateWorkflow<AgentTaskInput, AgentTaskOutput, AgentTaskConfig>;
  }
}

Workflow.prototype.agent = CreateWorkflow(AgentTask);
