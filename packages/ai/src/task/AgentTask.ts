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
} from "@workglow/task-graph";
import { CreateWorkflow, Entitlements, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import { createEmitQueue } from "../capability/emitQueue";
import type { ModelConfig } from "../model/ModelSchema";
import type { AgentApprovalMode } from "./AgentToolExecution";
import { clampToolText, runAgentTool } from "./AgentToolExecution";
import {
  DEFAULT_MAX_HISTORY_CHARS,
  normalizeHistoryForModel,
  trimHistoryForModel,
} from "./ChatHistory";
import type {
  ChatMessage,
  ContentBlock,
  ContentBlockInToolResultBody,
  ContentBlockToolResult,
} from "./ChatMessage";
import { ChatMessageSchema } from "./ChatMessage";
import { promptToUserMessage } from "./base/CheckpointPorts";
import { collectToolUseIds, uniquifyToolCallIds } from "./ToolCallIds";
import type { ToolCallingTaskInput, ToolCallingTaskOutput } from "./ToolCallingTask";
import { ToolCallingInputSchema, ToolCallingTask } from "./ToolCallingTask";
import type { ToolCall, ToolDefinition } from "./ToolCallingUtils";
import { compileToolValidators, sanitizeToolArgs } from "./ToolCallingUtils";

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
    approval: {
      type: "string",
      title: "Approval",
      description:
        'When a tool call is put to a person first: "beyond-inference" confirms any tool reaching past running a model, "never" confirms nothing',
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
        '"answered" when the model replied without asking for a tool, "max-rounds" when it ran out of rounds first',
      enum: ["answered", "max-rounds"],
    },
  },
  required: ["text", "messages", "rounds", "stopReason"],
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
  readonly approval?: AgentApprovalMode | undefined;
};

export type AgentTaskOutput = {
  text: string;
  messages: ChatMessage[];
  rounds: number;
  stopReason: "answered" | "max-rounds";
};

export type AgentTaskConfig = TaskConfig<AgentTaskInput>;

/** A call the model made that cannot be answered, so must not be committed. */
function isAnswerable(call: ToolCall): boolean {
  return typeof call.id === "string" && call.id.length > 0 && typeof call.name === "string";
}

function assistantMessage(text: string, calls: readonly ToolCall[]): ChatMessage {
  const content: ContentBlock[] = [];
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

/**
 * Every path into a `tool_result` is bounded by the same budget, not just the
 * one carrying a tool's output. "Unknown tool X. Available: …" names every tool
 * the caller registered, which on a large registry is as capable of filling a
 * context window as a fetched page — and it would then do it on every round the
 * model keeps guessing.
 */
/** The text of a settled call, as the model will read it. */
function toolResultText(result: ContentBlockToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toolResult(
  call: ToolCall,
  text: string,
  isError: boolean,
  maxChars: number
): ContentBlockToolResult {
  const body: ContentBlockInToolResultBody[] = [
    { type: "text", text: clampToolText(text, maxChars) },
  ];
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: body,
    is_error: isError ? true : undefined,
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
 * - **Tools run in order.** One may block on a person; the next must not race
 *   ahead of the answer.
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
    const approval: AgentApprovalMode = input.approval ?? "beyond-inference";
    const validators = compileToolValidators(input.tools);
    const byName = new Map(input.tools.map((tool) => [tool.name, tool]));

    const messages: ChatMessage[] = [...(input.messages ?? []), promptToUserMessage(input.prompt)];
    /**
     * The transcript so far, for a host drawing one while the turn is still
     * running — a tool card wants to exist from the moment the model asks for
     * it, not once the turn is over.
     *
     * A `snapshot` rather than an `object-delta` on the `messages` port: an
     * object-delta carrying an array is folded as an upsert list, so successive
     * whole-list snapshots would append into a transcript several times its own
     * length. A snapshot reaches subscribers and touches no output port.
     */
    const transcript = (): StreamEvent<AgentTaskOutput> =>
      ({ type: "snapshot", data: { messages: [...messages] } }) as StreamEvent<AgentTaskOutput>;
    let text = "";
    let rounds = 0;
    yield transcript();

    for (let round = 0; round < maxRounds; round++) {
      context.signal.throwIfAborted();
      rounds = round + 1;
      await context.updateProgress(undefined, "Thinking");

      const turn = new ToolCallingTask({ title: `Round ${rounds}` });
      const captured: { output: ToolCallingTaskOutput | undefined } = { output: undefined };
      for await (const event of this.streamRound(
        turn,
        captured,
        input,
        messages,
        maxHistoryChars,
        context
      )) {
        yield event;
      }
      const output = captured.output;
      // Summed from the round's settled output rather than from the deltas just
      // forwarded: a provider that reports its text only on the finish event
      // streams nothing, and counting deltas would report an empty answer while
      // `messages` carried the real one.
      text += output?.text ?? "";

      const calls = uniquifyToolCallIds(
        (output?.toolCalls ?? []).filter(isAnswerable),
        collectToolUseIds(messages)
      );
      // A turn with neither text nor a usable call records nothing: an empty
      // assistant message is not a reply, and providers reject a replayed
      // prefix containing one.
      const reply = assistantMessage(output?.text ?? "", calls);
      if (reply.content.length > 0) {
        messages.push(reply);
        yield transcript();
      }
      if (calls.length === 0) {
        yield { type: "finish", data: { text, messages, rounds, stopReason: "answered" } };
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

      const results: ContentBlockToolResult[] = [];
      for (const call of calls) {
        context.signal.throwIfAborted();
        await context.updateProgress(undefined, `Running ${call.name}`);
        yield { type: "tool-call", status: "running", toolCallId: call.id, name: call.name };
        const result = await this.runCall(call, byName, validators, context, {
          approval,
          maxResultChars: maxToolResultChars,
        });
        results.push(result);
        // Read back off the block rather than from a second copy of the text:
        // what the card says the call produced is then the same string the
        // model is about to read, clamp included.
        yield {
          type: "tool-call",
          status: result.is_error === true ? "failed" : "completed",
          toolCallId: call.id,
          name: call.name,
          result: toolResultText(result),
        };
      }
      messages.push({ role: "tool", content: results });
      yield transcript();
    }

    yield { type: "finish", data: { text, messages, rounds, stopReason: "max-rounds" } };
  }

  /**
   * Runs one round's model call and re-yields its text as this task's own.
   *
   * Owned, so the round shows up under this task and inherits the registry,
   * the abort signal and the run's usage accounting. The child's `toolCalls`
   * deltas are deliberately NOT forwarded: this task has no such port, and a
   * delta naming one would accumulate onto an output that does not exist.
   */
  private async *streamRound(
    turn: ToolCallingTask,
    captured: { output: ToolCallingTaskOutput | undefined },
    input: AgentTaskInput,
    messages: readonly ChatMessage[],
    maxHistoryChars: number,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<AgentTaskOutput>> {
    context.own(turn);
    const queue = createEmitQueue<StreamEvent<AgentTaskOutput>>();
    const off = turn.subscribe("stream_chunk", (event: StreamEvent) => {
      if (event.type !== "text-delta") return;
      if ((event.port ?? "text") !== "text") return;
      queue.push({ type: "text-delta", port: "text", textDelta: event.textDelta });
    });
    const run = (async () => {
      try {
        captured.output = await turn.run({
          model: input.model,
          prompt: input.prompt,
          systemPrompt: input.systemPrompt,
          messages: normalizeHistoryForModel(trimHistoryForModel(messages, maxHistoryChars)),
          tools: input.tools,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
        });
      } finally {
        off();
        queue.close();
      }
    })();
    // Held so a rejection while the queue is still draining is not reported as
    // unhandled; it is re-thrown below, once the events already produced have
    // reached the caller.
    run.catch(() => {});
    for await (const event of queue.iterable) yield event;
    await run;
  }

  /**
   * One tool call, from the model's arguments to what it reads back.
   *
   * Sanitising before validating is the order that matters: a `__proto__` key
   * would otherwise pass a schema that allows additional properties.
   */
  private async runCall(
    call: ToolCall,
    byName: ReadonlyMap<string, ToolDefinition>,
    validators: ReturnType<typeof compileToolValidators>,
    context: IExecuteContext,
    options: { readonly approval: AgentApprovalMode; readonly maxResultChars: number }
  ): Promise<ContentBlockToolResult> {
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
        const detail = check.errors.map((error) => error.message).join("; ") || "invalid arguments";
        return toolResult(
          call,
          `Invalid arguments for ${call.name}: ${detail}`,
          true,
          options.maxResultChars
        );
      }
    }
    const result = await runAgentTool(tool, { ...call, input: sanitized }, context, options);
    return toolResult(call, result.text, result.isError, options.maxResultChars);
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
