/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  StreamEvent,
  TaskInput,
  Usage,
} from "@workglow/task-graph";
import { mergeUsage, TaskConfigSchema, USAGE_OUTPUT_KEY } from "@workglow/task-graph";
import type { IHumanRequest } from "@workglow/util";
import { DEFAULT_LIMITS, resolveHumanConnector } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import { recordUsageTelemetry } from "../capability/UsageTelemetry";
import type { AiJobInput } from "../job/AiJob";
import type { ModelConfig } from "../model/ModelSchema";
import { getAiProviderRegistry } from "../provider/AiProviderRegistry";
import { disposeCheckpoint } from "../provider/CheckpointDisposal";
import { setCheckpointUsageSink } from "../provider/CheckpointRegistry";
import { TypeModel } from "./base/AiTaskSchemas";
import { runChatTurn } from "./base/chatTurn";
import type { ResolvedCheckpoint } from "./base/CheckpointPorts";
import { resolveCheckpointSession } from "./base/CheckpointPorts";
import { buildResponseFormatAddendum } from "./base/responseFormat";
import { StreamingAiTask } from "./base/StreamingAiTask";
import type { ChatMessage, ContentBlock } from "./ChatMessage";
import { ChatMessageSchema, ContentBlockSchema } from "./ChatMessage";

const modelSchema = TypeModel("model:AiChatTask");

/**
 * Connector elicit schema. The connector side renders a plain text field
 * for this — chat UIs let the user type a message, not author a JSON
 * ContentBlock array. AiChatTask wraps the string into
 * `[{ type: "text", text }]` before appending to the conversation.
 *
 * `content` is intentionally optional: submitting an empty message ends
 * the conversation (the chat loop treats empty content as "done"). A
 * consumer that wants to send structured content blocks directly (e.g.,
 * an image) can still bypass the elicit form and call `connector.send`
 * with `content: { content: ContentBlock[] }` — the task accepts both shapes.
 */
const chatConnectorContentSchema = {
  type: "object",
  properties: {
    content: {
      type: "string",
      title: "Message",
      description: "Your reply (leave blank to end the conversation)",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const AiChatInputSchema = {
  type: "object",
  properties: {
    model: modelSchema,
    prompt: {
      oneOf: [
        { type: "string", title: "Prompt", description: "The initial user message" },
        {
          type: "array",
          title: "Prompt",
          description: "The initial user message as structured content blocks",
          items: ContentBlockSchema,
        },
      ],
      title: "Prompt",
      description: "The first user message to start the conversation",
    },
    messages: {
      type: "array",
      title: "Messages",
      description:
        "Conversation history (managed internally by the chat loop; not a user-facing input)",
      items: ChatMessageSchema,
      "x-ui-hidden": true,
    },
    systemPrompt: {
      type: "string",
      title: "System Prompt",
      description: "Optional system instructions for the model",
    },
    maxTokens: {
      type: "number",
      title: "Max Tokens",
      description: "Per-turn token limit",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    temperature: {
      type: "number",
      title: "Temperature",
      description: "Sampling temperature",
      minimum: 0,
      maximum: 2,
      "x-ui-group": "Configuration",
    },
    maxIterations: {
      type: "number",
      title: "Max Iterations",
      description: "Safety cap on conversation turns",
      minimum: 1,
      default: 100,
      "x-ui-group": "Configuration",
    },
    responseFormat: {
      type: "string",
      enum: ["text", "markdown"],
      default: "text",
      title: "Response format",
      description:
        "How the model is instructed to format replies. 'text' = plain text. " +
        "'markdown' = GitHub-flavored Markdown.",
      "x-ui-group": "Configuration",
    },
    checkpoint: {
      type: "string",
      format: "cache-checkpoint",
      title: "Checkpoint",
      description: "Cache checkpoint the conversation starts from",
    },
  },
  required: ["model", "prompt"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const AiChatOutputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      // `x-stream: append` concatenates every `text-delta` from every turn,
      // so the accumulated value is the full transcript across turns — not
      // just the last assistant response. Consumers that need the most
      // recent assistant message should read it off the `messages` port
      // instead.
      description: "Full streamed transcript across all assistant turns",
      "x-stream": "append",
    },
    messages: {
      type: "array",
      title: "Messages",
      description: "Full conversation history",
      items: ChatMessageSchema,
      "x-stream": "object",
    },
    iterations: {
      type: "number",
      title: "Iterations",
      description: "Number of completed turns",
    },
  },
  required: ["text", "messages", "iterations"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

// ========================================================================
// Runtime types
// ========================================================================

// `prompt` is manually inlined as the `FromSchema` resolution of `ContentBlockSchema`
// for type-instantiation-budget reasons. The nightly drift guard in
// `__tests__/types.test-d.ts` asserts equality so a schema edit trips a test
// instead of silently drifting the runtime type.
export type AiChatTaskInput = Omit<
  {
    systemPrompt?: string | undefined;
    messages?: ChatMessage[] | undefined;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    maxIterations?: number | undefined;
    responseFormat?: "text" | "markdown" | undefined;
    checkpoint?: string | undefined;
    model: string | ModelConfig;
    prompt:
      | string
      | (
          | { type: "text"; text: string }
          | { type: "image"; mimeType: string; data: string }
          | {
              type: "tool_use";
              id: string;
              name: string;
              input: { [x: string]: unknown };
              providerSignature?: string | undefined;
            }
          | {
              is_error?: boolean | undefined;
              type: "tool_result";
              content: (
                | { type: "text"; text: string }
                | { type: "image"; mimeType: string; data: string }
                | {
                    type: "tool_use";
                    id: string;
                    name: string;
                    input: { [x: string]: unknown };
                    providerSignature?: string | undefined;
                  }
              )[];
              tool_use_id: string;
            }
          | { type: "reasoning"; text: string; provider?: string; payload?: string }
        )[];
  },
  "messages"
> & { readonly messages?: ReadonlyArray<ChatMessage> };

export type AiChatTaskOutput = { text: string; messages: ChatMessage[]; iterations: number };

/** Provider-facing input: same structural type as AiChatTaskInput, named separately for intent. */
export type AiChatProviderInput = AiChatTaskInput;

export interface AiChatProviderOutput {
  readonly text: string;
  [key: string]: unknown;
}

export class AiChatTask extends StreamingAiTask<AiChatTaskInput, AiChatTaskOutput> {
  public static override type = "AiChatTask";
  /** Capabilities required of the model; gated in {@link StreamingAiTask.executeStream}. */
  public static override readonly requires = ["text.generation"] as const satisfies Capability[];
  protected static override readonly streamingPhaseLabel = "Replying";
  public static override category = "AI Chat";
  public static override title = "AI Chat";
  public static override description =
    "Multi-turn chat with a language model, using a human connector to collect user input between turns.";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        ...TaskConfigSchema["properties"],
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public static override inputSchema(): DataPortSchema {
    return AiChatInputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return AiChatOutputSchema as DataPortSchema;
  }

  private _sessionId: string | undefined;

  /**
   * Checkpoint resolved on the conversation's first turn. Memoized so later
   * turns replay the captured prefix without re-consulting the registry: a
   * sibling task superseding (deleting) the checkpoint mid-conversation must
   * not abort a chat whose own session already carries the prefix state.
   */
  private _chatCheckpoint: ResolvedCheckpoint | undefined;

  protected override async getJobInput(
    input: AiChatTaskInput
  ): Promise<AiJobInput<AiChatTaskInput>> {
    const model = input.model as ModelConfig;
    if (!this._sessionId) {
      this._sessionId = getAiProviderRegistry().createSession(model.provider, model);
    }
    // Delegate to base so timeoutMs, outputSchema, and any future base fields
    // are always populated. The base reads (input as any).sessionId and
    // forwards it as jobInput.session.sessionId.
    const jobInput = await super.getJobInput({
      ...input,
      sessionId: this._sessionId,
    } as AiChatTaskInput & {
      sessionId: string;
    });
    if (input.checkpoint) {
      this._chatCheckpoint ??= resolveCheckpointSession(
        { checkpoint: input.checkpoint },
        model,
        "AiChatTask"
      );
      if (this._chatCheckpoint) {
        // The chat's own mutable session seeded from the checkpoint's content.
        // ownedSession keeps local providers' progressive per-turn KV
        // snapshotting alive — a checkpoint-seeded chat must never re-encode
        // the growing conversation each turn. seedCheckpointId lets providers
        // attach the checkpoint's warmed state (server cache entry or local KV
        // snapshot) instead of re-encoding the prefix on the first turn.
        jobInput.session = {
          sessionId: this._sessionId,
          seedCheckpointId: input.checkpoint,
          prefix: this._chatCheckpoint.session.prefix,
          ownedSession: true,
        };
      }
    }
    return jobInput;
  }

  override async *executeStream(
    input: AiChatTaskInput,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<AiChatTaskOutput>> {
    // Reset session so re-running the task starts a fresh conversation.
    this._sessionId = undefined;
    this._chatCheckpoint = undefined;

    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") {
      throw new Error("AiChatTask: model was not resolved to ModelConfig");
    }

    // Strict gating: this override doesn't call super.executeStream, so we
    // must gate here to match the contract AiTask.execute and
    // StreamingAiTask.executeStream both enforce.
    this.gateOrThrow(model);
    // Set here rather than inherited: this override never calls
    // super.executeStream, and StreamProcessor reads this field when it emits
    // `usage`, so leaving it unset files the whole conversation under no model.
    this.runUsageModelId = model.model_id;

    const connector = resolveHumanConnector(context);

    const history: ChatMessage[] = [];
    const addendum = buildResponseFormatAddendum(input.responseFormat);
    const composedSystemPrompt = [input.systemPrompt ?? "", addendum]
      .filter((s) => s.length > 0)
      .join("\n\n");
    if (composedSystemPrompt.length > 0) {
      history.push({
        role: "system",
        content: [{ type: "text", text: composedSystemPrompt }],
      });
    }
    const firstUserBlocks: ReadonlyArray<ContentBlock> =
      typeof input.prompt === "string"
        ? [{ type: "text", text: input.prompt }]
        : (input.prompt as ReadonlyArray<ContentBlock>);
    history.push({ role: "user", content: firstUserBlocks });

    // Initialize _sessionId before the loop.
    const workingInput: AiChatTaskInput = { ...input, messages: history };
    await this.getJobInput(workingInput);
    const strategy = getAiProviderRegistry().getStrategy(model);
    const maxIterations = input.maxIterations ?? DEFAULT_LIMITS.aiChatMaxIterations;

    if (context.resourceScope && this._sessionId) {
      const sessionId = this._sessionId;
      setCheckpointUsageSink(sessionId, (usage, modelId) => this.chargeLateUsage(usage, modelId));
      context.resourceScope.register(`ai:session:${String(sessionId)}`, async () => {
        await disposeCheckpoint(sessionId, model.provider);
      });
    }

    // Incremented after each completed assistant turn — emitted via
    // `finish.data.iterations` at the end so the output schema's required
    // `iterations` field is populated. (The streaming accumulator merges
    // `finish.data` over accumulated stream values; no `x-stream`
    // declaration applies to a one-shot scalar like this.)
    let completedTurns = 0;

    // Token accounting for the whole conversation. Each turn is its own provider
    // request, and only the outer finish reaches the caller, so the per-turn
    // counts have to be summed here or the run under-reports its cost by every
    // turn but the last.
    let conversationUsage: Usage | undefined;

    // Emit the initial messages as an object-delta. TaskRunner accumulates
    // array object-deltas by appending items (upsert-by-id when an `id`
    // field is present; plain append otherwise). ChatMessage has no id,
    // so we yield *deltas* — just the messages added since the last yield —
    // rather than full snapshots, or the accumulator would duplicate every
    // existing message on each emission.
    yield {
      type: "object-delta",
      port: "messages",
      objectDelta: [...history],
    } as StreamEvent<AiChatTaskOutput>;

    // `finally`, not a trailing call: a consumer that stops the chat early
    // closes this generator at a `yield` and never reaches the statement
    // after the loop — but the turns it already drove were still billed.
    // Recorded once per conversation, not once per turn: telemetry counts
    // one run's token accounting, and a chat run is one run.
    try {
      for (let turn = 0; turn < maxIterations; turn++) {
        const perTurnInput: AiChatTaskInput = { ...input, messages: [...history] };
        const turnJobInput = await this.getJobInput(perTurnInput);

        // The shared seam accumulates this turn's text and swallows the
        // inner-turn `finish` (the outer `finish` is emitted at the end),
        // keeping its `usage` sibling for the conversation total.
        const turn_ = runChatTurn<AiChatTaskOutput>({
          strategy,
          jobInput: turnJobInput as unknown as AiJobInput<TaskInput>,
          context,
          runnerId: this.runConfig.runnerId,
          textPort: "text",
        });
        let assistantText = "";
        // `finally`, not a trailing statement: a consumer that stops mid-turn
        // closes this generator at its `yield`, and the tokens that turn
        // already billed must still be accounted for.
        try {
          for await (const event of turn_.events) {
            yield event;
          }
        } finally {
          assistantText = turn_.text;
          conversationUsage = mergeUsage(conversationUsage, turn_.usage);
        }

        // A turn that produced no assistant content (provider emitted only
        // non-text events, an immediate finish, or an empty/aborted response)
        // must not append an empty assistant message to history nor count as a
        // completed turn — doing so poisons multi-turn context and burns a turn.
        // Treat it as end-of-conversation instead.
        if (assistantText.length === 0) {
          break;
        }

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        };
        history.push(assistantMsg);
        completedTurns = turn + 1;
        yield {
          type: "object-delta",
          port: "messages",
          objectDelta: [assistantMsg],
        } as StreamEvent<AiChatTaskOutput>;

        const request: IHumanRequest = {
          requestId: crypto.randomUUID(),
          targetHumanId: "default",
          kind: "elicit",
          message: "",
          contentSchema: chatConnectorContentSchema,
          contentData: undefined,
          expectsResponse: true,
          mode: "multi-turn",
          metadata: { iteration: turn, taskId: this.id },
        };

        const response = await connector.send(request, context.signal);
        if (response.action === "cancel" || response.action === "decline") break;

        // The elicit schema asks for a plain string; accept either shape so
        // programmatic callers can also send raw ContentBlock[] (e.g. images).
        // `response.done` is a form-completion flag (the submit happened), not
        // a conversation signal — do NOT treat it as end-of-chat. The signal
        // that the user wants to end the conversation is empty content.
        const raw = response.content?.content;
        let userContent: ContentBlock[];
        if (typeof raw === "string") {
          const text = raw.trim();
          userContent = text.length > 0 ? [{ type: "text", text: raw }] : [];
        } else if (Array.isArray(raw)) {
          userContent = raw as ContentBlock[];
        } else {
          userContent = [];
        }
        if (userContent.length === 0) break;

        const userMsg: ChatMessage = { role: "user", content: userContent };
        history.push(userMsg);
        yield {
          type: "object-delta",
          port: "messages",
          objectDelta: [userMsg],
        } as StreamEvent<AiChatTaskOutput>;
      }

      // `text` and `messages` ride the x-stream merge into the final output.
      // `iterations` has no x-stream, so we deliver it in `finish.data` for
      // the StreamProcessor to merge over the accumulated ports.
      yield {
        type: "finish",
        data: { iterations: completedTurns } as Partial<AiChatTaskOutput>,
        ...(conversationUsage ? { usage: conversationUsage } : {}),
      } as StreamEvent<AiChatTaskOutput>;
    } finally {
      if (conversationUsage) {
        recordUsageTelemetry({ [USAGE_OUTPUT_KEY]: conversationUsage }, this.type, model.model_id);
      }
    }
  }
}
