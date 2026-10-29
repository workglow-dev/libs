/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  StreamEvent,
  TaskConfig,
  TaskOutput,
  Usage,
} from "@workglow/task-graph";
import {
  getStreamingPorts,
  mergeUsage,
  TaskConfigurationError,
  USAGE_OUTPUT_KEY,
} from "@workglow/task-graph";

import { recordUsageTelemetry } from "../../capability/UsageTelemetry";
import type { ModelConfig } from "../../model/ModelSchema";
import { getAiProviderRegistry } from "../../provider/AiProviderRegistry";
import type { AiTaskInput } from "./AiTask";
import { AiTask } from "./AiTask";
import { runWithIterable } from "./runWithIterable";

/**
 * A base class for streaming AI tasks.
 * Extends AiTask to provide streaming output via executeStream().
 *
 * Subclasses set `streamMode` to control streaming behavior:
 * - 'append': each chunk is a delta (e.g., a new token). Default for text generation.
 * - 'object': each chunk is a progressively more complete partial object.
 * - 'replace': each chunk is a revised full snapshot of the output.
 *
 * The standard execute() method is preserved as a fallback that internally
 * consumes the stream to completion (so non-streaming callers get the same result).
 *
 * Port annotation: providers yield raw events without a `port` field.
 * This class wraps text-delta events with the correct port from the task's
 * output schema before they reach the TaskRunner.
 *
 * @cancel The `context.signal` is forwarded to the resolved execution strategy
 * (direct or queued), which in turn forwards it to the provider stream function.
 * When the signal fires, the underlying provider SDK tears down its connection
 * and the inner `for await` exits; this generator then returns or throws
 * promptly. Consumer-driven cancellation (an early `break` from the
 * `for await` consuming this generator) is also propagated: see
 * {@link runWithIterable} for the mechanism that converts a closed
 * consumer into an aborted provider signal. Partial accumulated text /
 * object state may still remain in task or runner state after abort (the
 * runner does not clear `runOutputData`) and MUST be treated as invalid
 * unless the final run status is `COMPLETED`. Subclasses overriding
 * `executeStream()` MUST preserve this contract: forward `context.signal`,
 * and either return or throw promptly after abort.
 */
export class StreamingAiTask<
  Input extends AiTaskInput = AiTaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends TaskConfig<Input> = TaskConfig<Input>,
> extends AiTask<Input, Output, Config> {
  public static override type: string = "StreamingAiTask";

  /**
   * Phase label emitted before the underlying provider stream begins
   * producing data events. Override in subclasses for task-specific
   * pre-stream phases (e.g. "Uploading" for tasks that prepare large
   * inputs).
   */
  protected static readonly preparingPhaseLabel: string = "Preparing";

  /**
   * Phase label emitted on the first data event from the underlying
   * provider stream (text-delta / object-delta / snapshot). Override in
   * subclasses to reflect what the task is producing — "Generating",
   * "Summarizing", "Translating", "Rendering", etc.
   */
  protected static readonly streamingPhaseLabel: string = "Streaming";

  /**
   * Streaming execution: resolves the provider strategy and yields StreamEvents from it.
   * Routes through the same strategy as execute() (queued vs direct) so GPU
   * serialization is respected even for streaming tasks.
   *
   * Wraps port-less text-delta and object-delta events from providers with
   * the port determined by the task's output schema `x-stream` annotations.
   */
  async *executeStream(input: Input, context: IExecuteContext): AsyncIterable<StreamEvent<Output>> {
    const model = input.model as ModelConfig;
    if (!model || typeof model !== "object") {
      throw new TaskConfigurationError(
        "StreamingAiTask: Model was not resolved to ModelConfig - this indicates a bug in the resolution system"
      );
    }

    // Strict gating: mirrors AiTask.execute — both paths must check before dispatch.
    this.gateOrThrow(model);

    this.runUsageModelId = model.model_id;

    const jobInput = await this.getJobInput(input);
    const strategy = getAiProviderRegistry().getStrategy(model);

    // Falls back to the first property in the output schema rather than
    // hardcoding "text", so non-text streaming tasks work correctly.
    const outSchema = this.outputSchema();
    const ports = getStreamingPorts(outSchema);
    let defaultPort = "text";
    if (ports.length > 0) {
      defaultPort = ports[0].port;
    } else {
      if (typeof outSchema === "object" && outSchema.properties) {
        const firstProp = Object.keys(outSchema.properties)[0];
        if (firstProp) defaultPort = firstProp;
      }
    }

    const ctor = this.constructor as typeof StreamingAiTask;
    const preparingLabel = ctor.preparingPhaseLabel;
    const streamingLabel = ctor.streamingPhaseLabel;

    // Default pre-stream phase: covers strategy resolution, queueing,
    // GPU acquisition, provider API connect time.
    yield { type: "phase", message: preparingLabel, progress: undefined } as StreamEvent<Output>;

    // Drive the strategy through `runWithIterable` so consumer abort
    // propagates to the provider stream.
    const iterable = runWithIterable<Output>(
      strategy,
      jobInput,
      context,
      this.runConfig.runnerId,
      (queue) => (event) => queue.push(event as StreamEvent<Output>)
    );

    let firstDataSeen = false;
    // Streaming tasks never reach `AiTask.execute`, so the telemetry call sited
    // there would never fire for them. Sum the provider's finish usage here and
    // record it once the stream drains — a run that streamed its answer costs
    // the same tokens as one that did not.
    let usage: Usage | undefined;
    // `finally`, not a trailing statement: a consumer that stops early closes
    // this generator at its `yield` instead of running past the loop. The
    // retry loop in `StructuredGenerationTask` does exactly that — it returns
    // (or breaks) the moment it sees `finish` — so a trailing call would never
    // record the tokens of the task that bills the most of them.
    try {
      for await (const event of iterable) {
        if (
          !firstDataSeen &&
          (event.type === "text-delta" ||
            event.type === "object-delta" ||
            event.type === "snapshot")
        ) {
          firstDataSeen = true;
          yield {
            type: "phase",
            message: streamingLabel,
            progress: undefined,
          } as StreamEvent<Output>;
        }

        if (event.type === "finish") {
          usage = mergeUsage(usage, event.usage);
        }

        if (event.type === "text-delta" || event.type === "text-retract") {
          yield { ...event, port: event.port ?? defaultPort } as StreamEvent<Output>;
        } else if (event.type === "object-delta") {
          yield { ...event, port: event.port ?? defaultPort } as StreamEvent<Output>;
        } else {
          yield event as StreamEvent<Output>;
        }
      }
    } finally {
      if (usage) {
        recordUsageTelemetry({ [USAGE_OUTPUT_KEY]: usage }, this.type, model.model_id);
      }
    }
  }
}
