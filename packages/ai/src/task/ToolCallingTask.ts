/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreateWorkflow, getTaskConstructors, Workflow } from "@workglow/task-graph";

import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  StreamEvent,
  TaskConfig,
} from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { asText, makeFingerprint } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { AiJobInput } from "../job/AiJob";
import type { ModelConfig } from "../model/ModelSchema";
import { disposeCheckpoint } from "../provider/CheckpointDisposal";
import type { CheckpointUsageSink } from "../provider/CheckpointRegistry";
import { checkpointModelKey } from "../provider/CheckpointRegistry";
import { TypeModel } from "./base/AiTaskSchemas";
import type { ResolvedCheckpoint } from "./base/CheckpointPorts";
import {
  CheckpointInputProperties,
  CheckpointOutputProperty,
  finalizeEmittedCheckpoint,
  promptToUserMessage,
  resolveCheckpointSession,
} from "./base/CheckpointPorts";
import { StreamingAiTask } from "./base/StreamingAiTask";
import type { ChatMessage } from "./ChatMessage";
import { ChatMessageSchema } from "./ChatMessage";
import type { ToolDefinition } from "./ToolCallingUtils";

export interface ToolDefinitionWithTaskType extends ToolDefinition {
  /** The task type name this definition was generated from. */
  readonly taskType: string;
}

/**
 * Converts an allow-list of task type names into {@link ToolDefinitionWithTaskType} objects
 * suitable for the ToolCallingTask input. Each entry carries the originating
 * `taskType` so callers don't need to rely on index correspondence.
 *
 * Each task's `type`, `description`, `inputSchema()`, and `outputSchema()`
 * are used to build the tool definition.
 *
 * @param taskNames - Array of task type names registered in the task constructors
 * @param registry - Optional service registry for DI-based lookups
 * @returns Array of ToolDefinitionWithTaskType objects
 * @throws Error if a task name is not found in the registry
 */
export function taskTypesToTools(
  taskNames: ReadonlyArray<string>,
  registry?: ServiceRegistry
): ToolDefinitionWithTaskType[] {
  const constructors = getTaskConstructors(registry);
  return taskNames.map((name) => {
    const ctor = constructors.get(name);
    if (!ctor) {
      throw new Error(
        `taskTypesToTools: Unknown task type "${name}" — not found in task constructors registry (ServiceRegistry: ${registry ? "custom" : "default"})`
      );
    }
    const configSchema =
      "configSchema" in ctor && typeof ctor.configSchema === "function"
        ? ctor.configSchema()
        : undefined;
    return {
      name: ctor.type,
      description: ctor.description ?? "",
      inputSchema: ctor.inputSchema(),
      outputSchema: ctor.outputSchema(),
      ...(configSchema ? { configSchema } : {}),
      taskType: name,
    };
  });
}

export const ToolDefinitionSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Name",
      description: "The tool name",
    },
    description: {
      type: "string",
      title: "Description",
      description: "A description of what the tool does",
    },
    inputSchema: {
      type: "object",
      title: "Input Schema",
      description: "JSON Schema describing the tool's input parameters",
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      title: "Output Schema",
      description: "JSON Schema describing what the tool returns",
      additionalProperties: true,
    },
    taskType: {
      type: "string",
      title: "Task Type",
      description:
        "The registered task type backing this tool, when it differs from the name the model sees",
    },
    configSchema: {
      type: "object",
      title: "Config Schema",
      description: "JSON Schema describing the task's configuration options (not sent to the LLM)",
      additionalProperties: true,
    },
    config: {
      type: "object",
      title: "Config",
      description: "Concrete configuration values for the backing task (not sent to the LLM)",
      additionalProperties: true,
    },
  },
  required: ["name", "description", "inputSchema"],
  additionalProperties: true,
} as const;

const ToolCallSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      title: "ID",
      description: "Unique identifier for this tool call",
    },
    name: {
      type: "string",
      title: "Name",
      description: "The name of the tool to invoke",
    },
    input: {
      type: "object",
      title: "Input",
      description: "The input arguments for the tool call",
      additionalProperties: true,
    },
    providerSignature: {
      type: "string",
      title: "Provider Signature",
      description:
        "Opaque provider-scoped signature (e.g. Gemini's thoughtSignature) to replay on later turns",
    },
  },
  required: ["id", "name", "input"],
  additionalProperties: false,
} as const;

const modelSchema = TypeModel("model:ToolCallingTask");

export const ToolCallingInputSchema = {
  type: "object",
  properties: {
    model: modelSchema,
    prompt: {
      oneOf: [
        { type: "string", title: "Prompt", description: "The prompt to send to the model" },
        {
          type: "array",
          title: "Prompt",
          description: "The prompt as an array of strings or content blocks",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["text", "image", "audio"] },
                },
                required: ["type"],
                additionalProperties: true,
              },
            ],
          },
        },
      ],
      title: "Prompt",
      description: "The prompt to send to the model",
    },
    systemPrompt: {
      type: "string",
      title: "System Prompt",
      description: "Optional system instructions for the model",
    },
    messages: {
      type: "array",
      title: "Messages",
      description:
        "Full conversation history for multi-turn interactions. When provided, used instead of prompt to construct the messages array sent to the provider.",
      items: ChatMessageSchema,
    },
    tools: {
      type: "array",
      format: "tasks",
      title: "Tools",
      description: "Tool definitions available for the model to call",
      items: {
        oneOf: [
          { type: "string", format: "tasks", description: "Task type name" },
          ToolDefinitionSchema,
        ],
      },
    },
    toolChoice: {
      type: "string",
      title: "Tool Choice",
      description:
        'Controls tool selection: "auto" (model decides), "none" (no tools), "required" (must call a tool), or a specific tool name',
      "x-ui-group": "Configuration",
    },
    maxTokens: {
      type: "number",
      title: "Max Tokens",
      description: "The maximum number of tokens to generate",
      minimum: 1,
      "x-ui-group": "Configuration",
    },
    temperature: {
      type: "number",
      title: "Temperature",
      description: "The temperature to use for sampling",
      minimum: 0,
      maximum: 2,
      "x-ui-group": "Configuration",
    },
    ...CheckpointInputProperties,
  },
  required: ["model", "prompt", "tools"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const ToolCallingOutputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Any text content generated by the model",
      "x-stream": "append",
    },
    toolCalls: {
      type: "array",
      items: ToolCallSchema,
      title: "Tool Calls",
      description: "Tool calls requested by the model",
      "x-stream": "object",
    },
    ...CheckpointOutputProperty,
  },
  required: ["text", "toolCalls"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

// `prompt` is manually inlined as the `FromSchema` resolution of the schema's
// array-item `oneOf` for type-instantiation-budget reasons. The nightly drift
// guard in `__tests__/types.test-d.ts` asserts equality so a schema edit trips
// a test instead of silently drifting the runtime type.
/**
 * Runtime input type for ToolCallingTask.
 *
 * The schema uses `oneOf: [string, object]` so the UI can accept both task-name
 * references and inline tool definitions, but the input resolver converts all
 * strings to {@link ToolDefinition} objects before execution. The `tools` field
 * is therefore narrowed to `ToolDefinition[]` here.
 *
 * Extends the schema-derived base with the
 * `messages` field typed explicitly (the loose `content: {}` in the
 * schema prevents `FromSchema` from producing a useful type).
 */
export type ToolCallingTaskInput = Omit<
  {
    systemPrompt?: string | undefined;
    messages?: ChatMessage[] | undefined;
    toolChoice?: string | undefined;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    model: string | ModelConfig;
    prompt: string | (string | { [x: string]: unknown; type: "text" | "image" | "audio" })[];
    tools: (
      | string
      | {
          [x: string]: unknown;
          outputSchema?: { [x: string]: unknown } | undefined;
          configSchema?: { [x: string]: unknown } | undefined;
          config?: { [x: string]: unknown } | undefined;
          description: string;
          name: string;
          inputSchema: { [x: string]: unknown };
        }
    )[];
  },
  "messages" | "tools"
> & {
  readonly tools: ToolDefinition[];
  readonly messages?: ReadonlyArray<ChatMessage> | undefined;
  readonly sessionId?: string | undefined;
  readonly checkpoint?: string | undefined;
  readonly emitCheckpoint?: boolean | undefined;
  readonly keepParentCheckpoint?: boolean | undefined;
};

export type ToolCallingTaskOutput = {
  text: string;
  toolCalls: {
    id: string;
    name: string;
    input: { [x: string]: unknown };
    providerSignature?: string;
  }[];
  checkpoint?: string | undefined;
};
export type ToolCallingTaskConfig = TaskConfig<ToolCallingTaskInput>;

export class ToolCallingTask extends StreamingAiTask<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCallingTaskConfig
> {
  public static override type = "ToolCallingTask";
  /** Capabilities required of the model; gated in {@link StreamingAiTask.executeStream}. */
  public static override readonly requires = ["tool-use"] as const satisfies Capability[];
  protected static override readonly streamingPhaseLabel = "Generating";
  public static override category = "AI Text";
  public static override title = "Tool Calling";
  public static override description =
    "Sends a prompt with tool definitions to a language model and returns text along with any tool calls the model requests";
  public static override inputSchema(): DataPortSchema {
    return ToolCallingInputSchema as DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return ToolCallingOutputSchema as DataPortSchema;
  }

  /** Session ID computed during getJobInput, used to register cleanup. */
  private _computedSessionId: string | undefined;

  /** Resolved checkpoint ports (rewind/emit) when the task consumes/emits checkpoints. */
  private _resolvedCheckpoint: ResolvedCheckpoint | undefined;

  /**
   * Checkpoint runs must never be output-cached: the emitted/consumed
   * checkpoint ids are run-scoped registry handles, so a cache hit would
   * replay an id whose session no longer exists.
   */
  public override getCachePolicy(inputs: ToolCallingTaskInput): CachePolicy {
    if (inputs.checkpoint || inputs.emitCheckpoint) return { kind: "none" };
    return super.getCachePolicy(inputs);
  }

  /**
   * Clear per-run session state left by a prior run of a reused task instance:
   * the resolved checkpoint and the auto-computed fingerprint session id (a
   * checkpoint run skips the fingerprint path, so a stale id from an earlier
   * run must not be re-registered on this run's scope). Done via a method (not
   * inline assignments) so control-flow analysis does not narrow
   * {@link _resolvedCheckpoint} to `undefined` for the rest of the caller —
   * {@link getJobInput} repopulates it before it is read.
   */
  private resetResolvedCheckpoint(): void {
    this._resolvedCheckpoint = undefined;
    this._computedSessionId = undefined;
  }

  /**
   * Override to auto-compute a prefix-rewind session ID from tools + systemPrompt
   * + runnerId when no explicit sessionId is provided. The runnerId scopes the
   * cache to the current graph run so it's cleaned up via ResourceScope.
   *
   * Explicit checkpoint ports (rewind/emit) take precedence over the
   * auto-fingerprint session.
   */
  protected override async getJobInput(
    input: ToolCallingTaskInput
  ): Promise<AiJobInput<ToolCallingTaskInput>> {
    const jobInput = await super.getJobInput(input);

    const model = input.model as ModelConfig;
    if ((input.checkpoint || input.emitCheckpoint) && model && typeof model === "object") {
      this._resolvedCheckpoint ??= resolveCheckpointSession(input, model, "ToolCallingTask");
      if (this._resolvedCheckpoint) {
        jobInput.session = this._resolvedCheckpoint.session;
        return jobInput;
      }
    }

    if (!jobInput.session?.sessionId && input.tools && input.tools.length > 0) {
      // Model identity must be part of the fingerprint: the local providers'
      // session maps are keyed by this id alone, so two models sharing a
      // toolset would otherwise reuse each other's KV state.
      const modelKey =
        model && typeof model === "object"
          ? `${model.provider}:${checkpointModelKey(model)}`
          : asText(input.model);
      const sessionId = await makeFingerprint({
        tools: input.tools,
        systemPrompt: input.systemPrompt,
        model: modelKey,
        runnerId: this.runConfig.runnerId,
      });
      jobInput.session = { sessionId };
      this._computedSessionId = sessionId;
    }

    return jobInput;
  }

  private registerSessionDispose(input: ToolCallingTaskInput, context: IExecuteContext): void {
    if (!context.resourceScope) return;

    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") return;

    const providerName = model.provider;

    const sessionId = this._computedSessionId;
    if (sessionId) {
      context.resourceScope.register(`ai:session:${sessionId}`, async () => {
        await disposeCheckpoint(sessionId, providerName);
      });
    }

    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    if (emitId) {
      context.resourceScope.register(`ai:session:${emitId}`, async () => {
        await disposeCheckpoint(emitId, providerName);
      });
    }
  }

  /**
   * Reports an emitted checkpoint's disposal-time storage charge as this
   * task's usage, and through it into the run total.
   */
  private storageChargeSink(): CheckpointUsageSink {
    return (usage, modelId) => this.chargeLateUsage(usage, modelId);
  }

  private async finalizeCheckpoint(
    input: ToolCallingTaskInput,
    out: { text: string; toolCalls: ToolCallingTaskOutput["toolCalls"] }
  ): Promise<void> {
    const resolved = this._resolvedCheckpoint;
    if (!resolved?.emitCheckpointId) return;
    const model = input.model as ModelConfig;
    const tailMessages: ChatMessage[] =
      input.messages && input.messages.length > 0
        ? [...input.messages]
        : [promptToUserMessage(input.prompt)];
    const assistantContent = [
      ...(out.text ? ([{ type: "text", text: out.text }] as const) : []),
      ...out.toolCalls.map(
        (tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }) as const
      ),
    ];
    await finalizeEmittedCheckpoint({
      model,
      resolved,
      tailMessages,
      // A turn with no text and no valid tool calls records no assistant
      // message — an empty one poisons the prefix for replay (Anthropic 400s).
      assistantMessage:
        assistantContent.length > 0 ? { role: "assistant", content: assistantContent } : undefined,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      onStorageCharge: this.storageChargeSink(),
    });
  }

  /**
   * Best-effort dispose of a minted-but-unfinalized emit checkpoint session.
   * When the run fails before {@link finalizeCheckpoint} records the registry
   * entry, only the provider session leaks (no checkpoint entry exists yet), so
   * dispose it directly. Dispose errors are swallowed.
   */
  private async disposeUnfinalizedEmitSession(
    input: ToolCallingTaskInput,
    emitId: string
  ): Promise<void> {
    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") return;
    try {
      await disposeCheckpoint(emitId, model.provider);
    } catch {
      // Best-effort cleanup: a dispose failure must not mask the original error.
    }
  }

  override async execute(
    input: ToolCallingTaskInput,
    executeContext: IExecuteContext
  ): Promise<ToolCallingTaskOutput | undefined> {
    // Reset any checkpoint resolved by a prior run of this reused instance so we
    // don't re-emit a stale minted id or re-supersede an already-gone parent.
    this.resetResolvedCheckpoint();
    // Register the session disposer BEFORE running so it still fires if
    // super.execute() throws or the stream aborts mid-iteration — the provider
    // may already have allocated the session on the first run-fn invocation.
    // The resourceScope is first-registration-wins and disposes via allSettled,
    // so computing the session id up front and registering early is safe.
    await this.getJobInput(input);
    this.registerSessionDispose(input, executeContext);
    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    let output: ToolCallingTaskOutput | undefined;
    try {
      output = await super.execute(input, executeContext);
    } catch (err) {
      if (emitId) await this.disposeUnfinalizedEmitSession(input, emitId);
      throw err;
    }
    if (output && emitId) {
      await this.finalizeCheckpoint(input, output);
      return { ...output, checkpoint: emitId };
    }
    return output;
  }

  override async *executeStream(
    input: ToolCallingTaskInput,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<ToolCallingTaskOutput>> {
    // Reset any checkpoint resolved by a prior run of this reused instance so we
    // don't re-emit a stale minted id or re-supersede an already-gone parent.
    this.resetResolvedCheckpoint();
    // Register the session disposer BEFORE streaming for the same reason as
    // execute(): an abort or throw mid-stream must still leave the disposer
    // registered so disposeSession runs on scope teardown.
    await this.getJobInput(input);
    this.registerSessionDispose(input, context);

    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    if (!emitId) {
      yield* super.executeStream(input, context);
      return;
    }

    let text = "";
    let toolCalls: ToolCallingTaskOutput["toolCalls"] = [];
    let finalized = false;
    try {
      for await (const event of super.executeStream(input, context)) {
        if (event.type === "text-delta" && (event.port ?? "text") === "text") {
          text += event.textDelta;
        } else if (event.type === "object-delta" && event.port === "toolCalls") {
          // Mirror StreamProcessor's canonical accumulation: array deltas are
          // upserts by id (OpenAI-shaped providers emit one single-element
          // array per tool call), non-array deltas replace.
          const delta = event.objectDelta;
          if (Array.isArray(delta)) {
            const merged = [...toolCalls];
            for (const item of delta as ToolCallingTaskOutput["toolCalls"]) {
              const idx = item.id !== undefined ? merged.findIndex((e) => e.id === item.id) : -1;
              if (idx >= 0) merged[idx] = item;
              else merged.push(item);
            }
            toolCalls = merged;
          } else {
            toolCalls = delta as unknown as ToolCallingTaskOutput["toolCalls"];
          }
        }
        if (event.type === "finish") {
          await this.finalizeCheckpoint(input, { text, toolCalls });
          finalized = true;
          yield {
            type: "text-delta",
            port: "checkpoint",
            textDelta: emitId,
          } as StreamEvent<ToolCallingTaskOutput>;
        }
        yield event;
      }
    } finally {
      // Stream error or abandonment before the finish event leaves the minted
      // emit session allocated but never registered — dispose it.
      if (!finalized) await this.disposeUnfinalizedEmitSession(input, emitId);
    }
  }
}

export const toolCalling = (
  input: ToolCallingTaskInput,
  config?: ToolCallingTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new ToolCallingTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    toolCalling: CreateWorkflow<ToolCallingTaskInput, ToolCallingTaskOutput, ToolCallingTaskConfig>;
  }
}

Workflow.prototype.toolCalling = CreateWorkflow(ToolCallingTask);
