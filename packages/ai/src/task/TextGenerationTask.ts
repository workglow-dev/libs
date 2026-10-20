/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  StreamEvent,
  TaskConfig,
} from "@workglow/task-graph";
import { CreateWorkflow, retractText, Workflow } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { AiJobInput } from "../job/AiJob";
import type { ModelConfig } from "../model/ModelSchema";
import { disposeCheckpoint } from "../provider/CheckpointDisposal";
import type { CheckpointUsageSink } from "../provider/CheckpointRegistry";
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

const generatedTextSchema = {
  type: "string",
  title: "Text",
  description: "The generated text",
  "x-stream": "append",
} as const;

const modelSchema = TypeModel("model:TextGenerationTask");

export const TextGenerationInputSchema = {
  type: "object",
  properties: {
    model: modelSchema,
    prompt: {
      type: "string",
      title: "Prompt",
      description: "The prompt to generate text from",
    },
    maxTokens: {
      type: "number",
      title: "Max Tokens",
      description:
        "Maximum tokens for the generated answer; providers add their own reasoning allowance on top",
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
    topP: {
      type: "number",
      title: "Top-p",
      description: "The top-p value to use for sampling",
      minimum: 0,
      maximum: 1,
      "x-ui-group": "Configuration",
    },
    frequencyPenalty: {
      type: "number",
      title: "Frequency Penalty",
      description: "The frequency penalty to use",
      minimum: -2,
      maximum: 2,
      "x-ui-group": "Configuration",
    },
    presencePenalty: {
      type: "number",
      title: "Presence Penalty",
      description: "The presence penalty to use",
      minimum: -2,
      maximum: 2,
      "x-ui-group": "Configuration",
    },
    ...CheckpointInputProperties,
  },
  required: ["model", "prompt"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const TextGenerationOutputSchema = {
  type: "object",
  properties: {
    text: generatedTextSchema,
    ...CheckpointOutputProperty,
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type TextGenerationTaskInput = {
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  frequencyPenalty?: number | undefined;
  presencePenalty?: number | undefined;
  model: string | ModelConfig;
  prompt: string;
  checkpoint?: string | undefined;
  emitCheckpoint?: boolean | undefined;
  keepParentCheckpoint?: boolean | undefined;
};
export type TextGenerationTaskOutput = { text: string; checkpoint?: string | undefined };
export type TextGenerationTaskConfig = TaskConfig<TextGenerationTaskInput>;

export class TextGenerationTask extends StreamingAiTask<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  TextGenerationTaskConfig
> {
  public static override type = "TextGenerationTask";
  /** Capabilities required of the model; gated in {@link StreamingAiTask.executeStream}. */
  public static override readonly requires = ["text.generation"] as const satisfies Capability[];
  protected static override readonly streamingPhaseLabel = "Generating";
  public static override category = "AI Text";
  public static override title = "Text Generation";
  public static override description =
    "Generates text from a prompt using language models with configurable parameters";
  public static override inputSchema(): DataPortSchema {
    return TextGenerationInputSchema as DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return TextGenerationOutputSchema as DataPortSchema;
  }

  private _resolvedCheckpoint: ResolvedCheckpoint | undefined;

  /**
   * Checkpoint runs must never be output-cached: the emitted/consumed
   * checkpoint ids are run-scoped registry handles, so a cache hit would
   * replay an id whose session no longer exists.
   */
  public override getCachePolicy(inputs: TextGenerationTaskInput): CachePolicy {
    if (inputs.checkpoint || inputs.emitCheckpoint) return { kind: "none" };
    return super.getCachePolicy(inputs);
  }

  /**
   * Clear the checkpoint resolved by a prior run of a reused task instance.
   * Done via a method (not an inline assignment) so control-flow analysis does
   * not narrow {@link _resolvedCheckpoint} to `undefined` for the rest of the
   * caller — {@link getJobInput} repopulates it before it is read.
   */
  private resetResolvedCheckpoint(): void {
    this._resolvedCheckpoint = undefined;
  }

  protected override async getJobInput(
    input: TextGenerationTaskInput
  ): Promise<AiJobInput<TextGenerationTaskInput>> {
    const jobInput = await super.getJobInput(input);
    const model = input.model as ModelConfig;
    if ((input.checkpoint || input.emitCheckpoint) && model && typeof model === "object") {
      this._resolvedCheckpoint ??= resolveCheckpointSession(input, model, "TextGenerationTask");
      if (this._resolvedCheckpoint) {
        jobInput.session = this._resolvedCheckpoint.session;
      }
    }
    return jobInput;
  }

  private registerCheckpointDispose(
    input: TextGenerationTaskInput,
    context: IExecuteContext
  ): void {
    if (!context.resourceScope) return;
    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") return;
    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    if (!emitId) return;
    const providerName = model.provider;
    context.resourceScope.register(`ai:session:${emitId}`, async () => {
      await disposeCheckpoint(emitId, providerName);
    });
  }

  /**
   * Reports an emitted checkpoint's disposal-time storage charge as this
   * task's usage, and through it into the run total.
   */
  private storageChargeSink(): CheckpointUsageSink {
    return (usage, modelId) => this.chargeLateUsage(usage, modelId);
  }

  private async finalizeCheckpoint(input: TextGenerationTaskInput, text: string): Promise<void> {
    const resolved = this._resolvedCheckpoint;
    if (!resolved?.emitCheckpointId) return;
    await finalizeEmittedCheckpoint({
      model: input.model as ModelConfig,
      resolved,
      tailMessages: [promptToUserMessage(input.prompt)],
      assistantMessage: text ? { role: "assistant", content: [{ type: "text", text }] } : undefined,
      systemPrompt: undefined,
      tools: undefined,
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
    input: TextGenerationTaskInput,
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
    input: TextGenerationTaskInput,
    executeContext: IExecuteContext
  ): Promise<TextGenerationTaskOutput | undefined> {
    // Reset any checkpoint resolved by a prior run of this reused instance so we
    // don't re-emit a stale minted id or re-supersede an already-gone parent.
    this.resetResolvedCheckpoint();
    // Only checkpoint runs need the job input up front (to mint/register the
    // emit session); plain runs let super.execute build it once.
    if (input.checkpoint || input.emitCheckpoint) {
      await this.getJobInput(input);
      this.registerCheckpointDispose(input, executeContext);
    }
    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    let output: TextGenerationTaskOutput | undefined;
    try {
      output = await super.execute(input, executeContext);
    } catch (err) {
      if (emitId) await this.disposeUnfinalizedEmitSession(input, emitId);
      throw err;
    }
    if (output && emitId) {
      await this.finalizeCheckpoint(input, output.text);
      return { ...output, checkpoint: emitId };
    }
    return output;
  }

  override async *executeStream(
    input: TextGenerationTaskInput,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<TextGenerationTaskOutput>> {
    // Reset any checkpoint resolved by a prior run of this reused instance so we
    // don't re-emit a stale minted id or re-supersede an already-gone parent.
    this.resetResolvedCheckpoint();
    // Only checkpoint runs need the job input up front (to mint/register the
    // emit session); plain runs let super.executeStream build it once.
    if (input.checkpoint || input.emitCheckpoint) {
      await this.getJobInput(input);
      this.registerCheckpointDispose(input, context);
    }
    const emitId = this._resolvedCheckpoint?.emitCheckpointId;
    if (!emitId) {
      yield* super.executeStream(input, context);
      return;
    }
    let text = "";
    let finalized = false;
    try {
      for await (const event of super.executeStream(input, context)) {
        if (event.type === "text-delta" && (event.port ?? "text") === "text") {
          text += event.textDelta;
        } else if (event.type === "text-retract" && (event.port ?? "text") === "text") {
          text = retractText(text, event.length);
        }
        if (event.type === "finish") {
          await this.finalizeCheckpoint(input, text);
          finalized = true;
          yield {
            type: "text-delta",
            port: "checkpoint",
            textDelta: emitId,
          } as StreamEvent<TextGenerationTaskOutput>;
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

export const textGeneration = (
  input: TextGenerationTaskInput,
  config?: TextGenerationTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new TextGenerationTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    textGeneration: CreateWorkflow<
      TextGenerationTaskInput,
      TextGenerationTaskOutput,
      TextGenerationTaskConfig
    >;
  }
}

Workflow.prototype.textGeneration = CreateWorkflow(TextGenerationTask);
