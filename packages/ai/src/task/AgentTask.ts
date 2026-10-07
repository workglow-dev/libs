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
import { createEmitQueue } from "../capability/emitQueue";
import { readUsage } from "../capability/UsageTelemetry";
import type { ModelConfig } from "../model/ModelSchema";
import type { AgentRoundRunner } from "./AgentRoundRunner";
import { AGENT_ROUND_RUNNER } from "./AgentRoundRunner";
import { assertModelMeetsRequires } from "./base/AiTask";
import type { AgentApprovalMode } from "./AgentToolExecution";
import { clampToolText, runAgentTool, toolCallNeedsApproval } from "./AgentToolExecution";
import type { AgentStep, AgentSubmissionCheck, AgentToolRecord } from "./AgentTurnRecord";
import {
  AGENT_SUBMIT_TOOL_NAME,
  agentModelPricing,
  isRetryableRoundError,
  promptTokens,
  retryDelayMs,
  roundCostUsd,
  sleepUnlessAborted,
} from "./AgentTurnRecord";
import {
  DEFAULT_MAX_HISTORY_CHARS,
  normalizeHistoryForModel,
  trimHistoryForModel,
} from "./ChatHistory";
import type {
  ChatMessage,
  ContentBlock,
  ContentBlockImage,
  ContentBlockInToolResultBody,
  ContentBlockToolResult,
} from "./ChatMessage";
import { ChatMessageSchema } from "./ChatMessage";
import { promptToUserMessage } from "./base/CheckpointPorts";
import { collectToolUseIds, uniquifyToolCallIds } from "./ToolCallIds";
import type { ToolCallingTaskInput, ToolCallingTaskOutput } from "./ToolCallingTask";
import { ToolCallingInputSchema, ToolCallingTask } from "./ToolCallingTask";
import type { ToolCall, ToolDefinition } from "./ToolCallingUtils";
import {
  compileToolValidators,
  describeSchemaErrors,
  sanitizeToolArgs,
  ToolCallError,
} from "./ToolCallingUtils";
import { RetryableJobError } from "@workglow/job-queue";

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

/**
 * Times a turn with an `outputSchema` reminds a model that replied in text to
 * submit instead. Some models narrate a final answer out of habit and submit
 * when told; one that still will not after this is not going to.
 */
const MAX_SUBMIT_REMINDERS = 2;

/**
 * Times a host's `checkSubmission` may turn an answer away. A check that keeps
 * objecting is either wrong or asking for what the filing does not hold, and
 * the turn must still end with the answer the model could give.
 */
const MAX_SUBMISSION_REJECTIONS = 2;

const SUBMIT_REMINDER =
  `Call ${AGENT_SUBMIT_TOOL_NAME} with your final answer. ` +
  "An answer given as text is not recorded.";

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
        "Prompt tokens, cached or not, summed over the turn's rounds, after which it stops with stopReason budget",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    maxCostUsd: {
      type: "number",
      title: "Max Cost (USD)",
      description:
        "Estimated spend after which the turn stops with stopReason budget. Needs a price card for the model. Fails closed: a round whose usage the provider did not report cannot be priced, so the turn stops with stopReason budget after that round",
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

/** The host's round runner, when it bound one on this run's registry. */
function roundRunnerOf(context: IExecuteContext): AgentRoundRunner | undefined {
  return context.registry.has(AGENT_ROUND_RUNNER)
    ? context.registry.get(AGENT_ROUND_RUNNER)
    : undefined;
}

/** A call the model made that cannot be answered, so must not be committed. */
function isAnswerable(call: ToolCall): boolean {
  return typeof call.id === "string" && call.id.length > 0 && typeof call.name === "string";
}

function assistantMessage(
  text: string,
  calls: readonly ToolCall[],
  reasoning: string | undefined
): ChatMessage {
  const content: ContentBlock[] = [];
  // Reasoning rides only on a reply that has something else: on its own it is
  // not a reply, and an assistant turn with no text and no call is rejected.
  if (reasoning && (text.length > 0 || calls.length > 0)) {
    content.push({ type: "reasoning", text: reasoning });
  }
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
      ...(call.providerSignature === undefined
        ? {}
        : { providerSignature: call.providerSignature }),
    });
  }
  return { role: "assistant", content };
}

/** The text of a settled call, as the model will read it. */
function toolResultText(result: ContentBlockToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Every path into a `tool_result` is bounded by the same budget, not just the
 * one carrying a tool's output. "Unknown tool X. Available: …" names every tool
 * the caller registered, which on a large registry is as capable of filling a
 * context window as a fetched page — and it would then do it on every round the
 * model keeps guessing.
 */
function toolResult(
  call: ToolCall,
  text: string,
  isError: boolean,
  maxChars: number,
  images: ReadonlyArray<ContentBlockImage> = []
): ContentBlockToolResult {
  const body: ContentBlockInToolResultBody[] = [
    { type: "text", text: clampToolText(text, maxChars) },
    ...images,
  ];
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: body,
    is_error: isError ? true : undefined,
  };
}

/** The time a turn has left, as the model is shown it: whole seconds, rounded down. */
function timeLeftNotice(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `\n\n[Time left: ${minutes > 0 ? `${minutes}m ` : ""}${total % 60}s]`;
}

interface RunCallOptions {
  readonly byName: ReadonlyMap<string, ToolDefinition>;
  readonly validators: ReturnType<typeof compileToolValidators>;
  readonly approval: AgentApprovalMode;
  readonly maxResultChars: number;
  /** When the turn's time budget runs out; see {@link ToolExecuteContext.deadline}. */
  readonly deadline: number | undefined;
  /** The tool that submits the answer, when the turn has an `outputSchema`. */
  readonly submitToolName: string | undefined;
}

/**
 * The tool a turn with an `outputSchema` finishes with: its arguments are the
 * answer, checked against that schema like any tool's arguments, so a failing
 * answer comes back to the model as an error it can correct.
 */
function submitToolFor(
  outputSchema: JsonSchema | undefined,
  onSubmit: (value: unknown) => Promise<string | undefined>
): ToolDefinition | undefined {
  // The runner fills an object port the caller left unset with `{}`, and an
  // empty schema constrains nothing: a submit tool built from one would accept
  // any arguments at all, so it counts as no schema.
  if (
    outputSchema === undefined ||
    (typeof outputSchema === "object" && Object.keys(outputSchema).length === 0)
  ) {
    return undefined;
  }
  return {
    name: AGENT_SUBMIT_TOOL_NAME,
    description:
      "Submit your final answer. It is checked against the required schema: if it is rejected, fix what the error names and call this again.",
    inputSchema: outputSchema,
    // Recording an answer reaches nothing beyond the turn itself.
    requiresApproval: false,
    execute: async (input) => {
      const reason = await onSubmit(input);
      // Thrown as the tool's own words: the model reads the reason itself, not
      // a wrapped error, and answers it in its next round.
      if (reason !== undefined) {
        // The whole answer again, not a patch: a model resubmitting only what the
        // reason named drops every section it had already filled.
        throw new ToolCallError(
          `Answer not recorded yet. ${reason} Then call submit_answer again with the complete ` +
            "answer — every field, including those this does not mention, as you had them."
        );
      }
      return "Answer recorded.";
    },
  };
}

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

    let submitted: { readonly value: unknown } | undefined;
    const submissionRejections: string[] = [];
    // Read through a getter: the transcript and step list are declared below,
    // and a check sees them as they stand when the model submits.
    let turnSoFar = (): { messages: readonly ChatMessage[]; steps: readonly AgentStep[] } => ({
      messages: [],
      steps: [],
    });
    const submitTool = submitToolFor(input.outputSchema, async (value) => {
      if (
        input.checkSubmission !== undefined &&
        submissionRejections.length < MAX_SUBMISSION_REJECTIONS
      ) {
        const reason = await input.checkSubmission(value, {
          ...turnSoFar(),
          rejections: submissionRejections.length,
        });
        if (reason !== undefined && reason.trim() !== "") {
          submissionRejections.push(reason);
          return reason;
        }
      }
      submitted = { value };
      return undefined;
    });
    if (submitTool !== undefined && input.tools.some((tool) => tool.name === submitTool.name)) {
      throw new TaskConfigurationError(
        `AgentTask: a tool named "${submitTool.name}" is reserved for submitting against outputSchema`
      );
    }
    const tools = submitTool === undefined ? input.tools : [...input.tools, submitTool];
    const validators = compileToolValidators(tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const roundTurn: AgentTaskInput = { ...input, tools };

    const pricing = await agentModelPricing(input.model, context.registry);
    if (input.maxCostUsd !== undefined && pricing === undefined) {
      // A budget that cannot be measured would never stop the turn, and the
      // caller set it precisely so that something would.
      throw new TaskConfigurationError(
        "AgentTask: maxCostUsd needs a price card for the model, and none was found"
      );
    }
    if (input.announceTimeLeft && input.maxDurationMs === undefined) {
      throw new TaskConfigurationError(
        "AgentTask: announceTimeLeft needs maxDurationMs, the budget it announces"
      );
    }

    const startedAt = Date.now();
    const deadline =
      input.maxDurationMs === undefined ? undefined : startedAt + input.maxDurationMs;
    const steps: AgentStep[] = [];
    let spentTokens = 0;
    let spentUsd = 0;
    let costKnown = true;
    // A round that reported no usage cannot be priced, and adding nothing for it
    // would let a capped turn run every round for free. With maxCostUsd set it
    // counts as spending the cap: the turn stops after that round.
    let unmeteredRound = false;
    let reminders = 0;
    let reviewed = false;

    const messages: ChatMessage[] = [...(input.messages ?? []), promptToUserMessage(input.prompt)];
    turnSoFar = () => ({ messages, steps });
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
    let rounds = 0;
    const finish = (stopReason: AgentStopReason): StreamEvent<AgentTaskOutput> => ({
      type: "finish",
      data: {
        text,
        messages,
        rounds,
        stopReason,
        steps,
        submissionRejections,
        ...(submitted === undefined ? {} : { object: submitted.value }),
        ...(costKnown && steps.length > 0 ? { costUsd: spentUsd } : {}),
      },
    });
    const overBudget = (): boolean =>
      (input.maxInputTokens !== undefined && spentTokens >= input.maxInputTokens) ||
      (input.maxCostUsd !== undefined && (unmeteredRound || spentUsd >= input.maxCostUsd));
    yield transcript();

    for (let round = 0; round < maxRounds; round++) {
      context.signal.throwIfAborted();
      if (input.maxDurationMs !== undefined && Date.now() - startedAt >= input.maxDurationMs) {
        yield finish("budget");
        return;
      }
      rounds = round + 1;
      await context.updateProgress(undefined, "Thinking");
      const roundStart = Date.now();

      const captured: { output: ToolCallingTaskOutput | undefined } = { output: undefined };
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          for await (const event of this.streamRound(
            rounds,
            captured,
            roundTurn,
            messages,
            maxHistoryChars,
            context,
            input.roundTimeoutMs
          )) {
            yield event;
          }
          break;
        } catch (err) {
          if (attempts > maxRoundRetries || !isRetryableRoundError(err)) throw err;
          context.signal.throwIfAborted();
          const wait = retryDelayMs(err, attempts);
          await context.updateProgress(undefined, `Retrying in ${Math.ceil(wait / 1000)}s`);
          await sleepUnlessAborted(wait, context.signal);
        }
      }
      const modelMs = Date.now() - roundStart;
      const output = captured.output;
      const usage = readUsage(output as TaskOutput | undefined);
      const costUsd = roundCostUsd(usage, pricing, new Date(roundStart));
      // Summed from the round's settled output rather than from the deltas just
      // forwarded: a provider that reports its text only on the finish event
      // streams nothing, and counting deltas would report an empty answer while
      // `messages` carried the real one.
      text += output?.text ?? "";

      const record = (toolRecords: readonly AgentToolRecord[]): void => {
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
        spentTokens += promptTokens(usage);
        if (costUsd === undefined) {
          costKnown = false;
          unmeteredRound = true;
        } else spentUsd += costUsd;
      };

      const calls = uniquifyToolCallIds(
        (output?.toolCalls ?? []).filter(isAnswerable),
        collectToolUseIds(messages)
      );
      // A turn with neither text nor a usable call records nothing: an empty
      // assistant message is not a reply, and providers reject a replayed
      // prefix containing one.
      const reply = assistantMessage(output?.text ?? "", calls, output?.reasoning);
      if (reply.content.length > 0) {
        messages.push(reply);
        yield transcript();
      }
      if (calls.length === 0) {
        record([]);
        // A turn with an outputSchema has checkSubmission for this, and a review
        // sent with no round, budget or time left could never be acted on.
        if (
          input.reviewPrompt &&
          !reviewed &&
          submitTool === undefined &&
          round + 1 < maxRounds &&
          !overBudget() &&
          (deadline === undefined || Date.now() < deadline)
        ) {
          reviewed = true;
          messages.push({ role: "user", content: [{ type: "text", text: input.reviewPrompt }] });
          yield transcript();
          continue;
        }
        if (submitTool !== undefined && reminders < MAX_SUBMIT_REMINDERS && !overBudget()) {
          reminders++;
          messages.push({ role: "user", content: [{ type: "text", text: SUBMIT_REMINDER }] });
          yield transcript();
          continue;
        }
        yield finish(overBudget() ? "budget" : "answered");
        return;
      }

      // Every call the model asked for, announced before any of them runs: it
      // asked for them together, and a host laying out cards can draw the whole
      // set rather than watching them appear one at a time in an order that is
      // this loop's business and not the model's.
      for (const call of calls) {
        yield {
          type: "tool-call",
          status: "pending",
          toolCallId: call.id,
          name: call.name,
          input: call.input,
        };
      }

      // A call put to a person is never raced: the next one must not run ahead
      // of the answer, so a round holding one runs every call in turn.
      const width = calls.some((call) => {
        const tool = byName.get(call.name);
        return tool !== undefined && toolCallNeedsApproval(tool, approval, context.registry);
      })
        ? 1
        : toolConcurrency;
      const results: ContentBlockToolResult[] = [];
      const toolRecords: AgentToolRecord[] = [];
      for await (const event of this.runCalls(calls, width, results, toolRecords, context, {
        byName,
        validators,
        approval,
        maxResultChars: maxToolResultChars,
        deadline,
        submitToolName: submitTool?.name,
      })) {
        yield event;
      }
      // On the last result rather than in a message of its own: a tool message
      // holds only tool results, and the tail of the transcript is the one place
      // a changing line costs no prompt cache.
      if (input.announceTimeLeft && deadline !== undefined && results.length > 0) {
        const last = results[results.length - 1]!;
        results[results.length - 1] = {
          ...last,
          content: [...last.content, { type: "text", text: timeLeftNotice(deadline - Date.now()) }],
        };
      }
      messages.push({ role: "tool", content: results });
      record(toolRecords);
      yield transcript();
      if (submitted !== undefined) {
        yield finish("submitted");
        return;
      }
      if (overBudget()) {
        yield finish("budget");
        return;
      }
    }

    yield finish("max-rounds");
  }

  /**
   * Runs one round's calls, `width` at a time, and reports each one running and
   * settled. `results` and `records` are filled in the order the model asked,
   * whatever order the calls finish in, because that is the order its next
   * round reads them.
   */
  private async *runCalls(
    calls: readonly ToolCall[],
    width: number,
    results: ContentBlockToolResult[],
    records: AgentToolRecord[],
    context: IExecuteContext,
    options: RunCallOptions
  ): AsyncIterable<StreamEvent<AgentTaskOutput>> {
    const queue = createEmitQueue<StreamEvent<AgentTaskOutput>>();
    const settled: Array<{ result: ContentBlockToolResult; record: AgentToolRecord } | undefined> =
      calls.map(() => undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < calls.length) {
        context.signal.throwIfAborted();
        const index = next++;
        const call = calls[index]!;
        await context.updateProgress(undefined, `Running ${call.name}`);
        queue.push({ type: "tool-call", status: "running", toolCallId: call.id, name: call.name });
        const began = Date.now();
        const result = await this.runCall(call, context, options);
        const resultText = toolResultText(result);
        settled[index] = {
          result,
          record: {
            id: call.id,
            name: call.name,
            isError: result.is_error === true,
            chars: resultText.length,
            durationMs: Date.now() - began,
          },
        };
        // Read back off the block rather than from a second copy of the text:
        // what the card says the call produced is then the same string the
        // model is about to read, clamp included.
        queue.push({
          type: "tool-call",
          status: result.is_error === true ? "failed" : "completed",
          toolCallId: call.id,
          name: call.name,
          result: resultText,
        });
      }
    };
    const run = Promise.all(
      Array.from({ length: Math.min(width, calls.length) }, () => worker())
    ).finally(() => queue.close());
    // Held so a rejection while the queue is still draining is not reported as
    // unhandled; it is re-thrown below, once the events already produced have
    // reached the caller.
    run.catch(() => {});
    for await (const event of queue.iterable) yield event;
    await run;
    for (const entry of settled) {
      results.push(entry!.result);
      records.push(entry!.record);
    }
  }

  /**
   * Runs one round's model call and re-yields its text as this task's own.
   *
   * Owned, so the round shows up under this task and inherits the registry,
   * the abort signal and the run's usage accounting. The child's `toolCalls`
   * deltas are deliberately NOT forwarded: this task has no such port, and a
   * delta naming one would accumulate onto an output that does not exist.
   *
   * A host that bound {@link AGENT_ROUND_RUNNER} runs the round itself instead,
   * and nothing is owned: the round happens wherever the host sent it.
   */
  private async *streamRound(
    round: number,
    captured: { output: ToolCallingTaskOutput | undefined },
    input: AgentTaskInput,
    messages: readonly ChatMessage[],
    maxHistoryChars: number,
    context: IExecuteContext,
    timeoutMs: number | undefined
  ): AsyncIterable<StreamEvent<AgentTaskOutput>> {
    const roundInput: ToolCallingTaskInput = {
      model: input.model,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      messages: normalizeHistoryForModel(trimHistoryForModel(messages, maxHistoryChars)),
      tools: input.tools,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    };
    const hostRunner = roundRunnerOf(context);
    const queue = createEmitQueue<StreamEvent<AgentTaskOutput>>();
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
      if (typeof input.model === "object") {
        assertModelMeetsRequires(input.model, ToolCallingTask.requires, ToolCallingTask.type);
      }
      runRound = () =>
        hostRunner(roundInput, {
          signal: AbortSignal.any([context.signal, roundAbort.signal]),
          onTextDelta: (delta) =>
            queue.push({ type: "text-delta", port: "text", textDelta: delta }),
          // Progress is advisory: a failed update must not surface as an
          // unhandled rejection, nor fail a round that is otherwise fine.
          onProgress: (progress, message) => {
            context.updateProgress(progress, message).catch(() => {});
          },
        });
    } else {
      const turn = new ToolCallingTask({ title: `Round ${round}` });
      context.own(turn);
      abandon = () => turn.abort();
      off = turn.subscribe("stream_chunk", (event: StreamEvent) => {
        if (event.type !== "text-delta") return;
        if ((event.port ?? "text") !== "text") return;
        queue.push({ type: "text-delta", port: "text", textDelta: event.textDelta });
      });
      runRound = () => turn.run(roundInput);
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abandon();
          }, timeoutMs);
    const run = (async () => {
      try {
        captured.output = await runRound();
      } catch (err) {
        if (timedOut && !context.signal.aborted) {
          throw new RetryableJobError(`Round ${round} had no answer within ${timeoutMs} ms`);
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        off();
        queue.close();
      }
    })();
    // Held so a rejection while the queue is still draining is not reported as
    // unhandled; it is re-thrown below, once the events already produced have
    // reached the caller.
    run.catch(() => {});
    // Held until the attempt settles: the stream accumulates every delta it is
    // handed into the task's text port and offers no way to take one back, so
    // text forwarded from an attempt that then fails and is retried would be
    // joined to the retry's. A failed attempt throws here and its text is dropped.
    const held: StreamEvent<AgentTaskOutput>[] = [];
    for await (const event of queue.iterable) held.push(event);
    await run;
    for (const event of held) yield event;
  }

  /**
   * One tool call, from the model's arguments to what it reads back.
   *
   * Sanitising before validating is the order that matters: a `__proto__` key
   * would otherwise pass a schema that allows additional properties.
   */
  private async runCall(
    call: ToolCall,
    context: IExecuteContext,
    options: RunCallOptions
  ): Promise<ContentBlockToolResult> {
    const { byName, validators } = options;
    const tool = byName.get(call.name);
    if (!tool) {
      const known = [...byName.keys()].join(", ");
      return toolResult(
        call,
        `Unknown tool "${call.name}". Available: ${known}`,
        true,
        options.maxResultChars
      );
    }
    const sanitized = sanitizeToolArgs(call.input) as Record<string, unknown>;
    const validator = validators.get(call.name);
    if (validator) {
      const check = validator.validate(sanitized);
      if (!check.valid) {
        const detail = describeSchemaErrors(check.errors);
        // The answer itself failed its schema: say so as a correction to make,
        // which is what gets a model to resubmit rather than give up.
        const text =
          call.name === options.submitToolName
            ? `Answer rejected; nothing was recorded. Fix these and call ${call.name} again with the complete answer: ${detail}`
            : `Invalid arguments for ${call.name}: ${detail}`;
        return toolResult(call, text, true, options.maxResultChars);
      }
    }
    const result = await runAgentTool(tool, { ...call, input: sanitized }, context, {
      approval: options.approval,
      maxResultChars: options.maxResultChars,
      deadline: options.deadline,
    });
    return toolResult(call, result.text, result.isError, options.maxResultChars, result.images);
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
