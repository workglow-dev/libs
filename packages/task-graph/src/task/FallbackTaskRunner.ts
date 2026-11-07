/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridgeSubGraphTaskEvents } from "../task-graph/SubGraphEventBridge";
import type { FallbackTask, FallbackTaskConfig } from "./FallbackTask";
import { GraphAsTaskRunner } from "./GraphAsTaskRunner";
import type { ITask } from "./ITask";
import { TaskAbortedError, TaskFailedError, TaskTimeoutError } from "./TaskError";
import type { TaskRunContext } from "./TaskRunContext";
import type { TaskInput, TaskOutput } from "./TaskTypes";
import { TaskStatus } from "./TaskTypes";

/**
 * Runner for FallbackTask that executes alternatives sequentially until one succeeds.
 *
 * In **task mode**, each task in the subgraph is tried independently.
 * In **data mode**, the entire subgraph is re-run with different input overrides.
 */
export class FallbackTaskRunner<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends FallbackTaskConfig<Input> = FallbackTaskConfig<Input>,
> extends GraphAsTaskRunner<Input, Output, Config> {
  declare task: FallbackTask<Input, Output, Config>;

  /**
   * Override executeTask to implement sequential fallback logic.
   */
  protected override async executeTask(
    input: Input,
    ctx: TaskRunContext
  ): Promise<Output | undefined> {
    if (this.task.fallbackMode === "data") {
      return this.executeDataFallback(input, ctx.abortController.signal);
    }
    return this.executeTaskFallback(input, ctx.abortController.signal);
  }

  /**
   * For FallbackTask, preview runs use the task's preview hook only,
   * bypassing GraphAsTaskRunner's child-merging logic.
   */
  public override async executeTaskPreview(
    input: Input,
    _ctx: TaskRunContext
  ): Promise<Output | undefined> {
    return this.task.executePreview?.(input, { own: this.own });
  }

  // ========================================================================
  // Task Mode: Try each task in the subgraph as an independent alternative
  // ========================================================================

  /**
   * Tries each task in the subgraph sequentially. Returns the first
   * successful result. If all fail, throws with collected errors.
   *
   * NOTE: alternatives are run via `alternativeTask.run(input)` directly, not
   * through the subGraph runner, so the `bridgeSubGraphTaskEvents` bridge used in
   * data mode does not apply here — there is no subgraph run to bridge from.
   * Consequently inner alternatives' task_progress/task_complete/task_stream_*
   * events do not bubble to the top-level run stream in task mode (data mode does
   * surface them). Coarse attempt progress is forwarded via handleProgress below.
   *
   * For the same reason nothing hands an alternative this run's context, so it is
   * passed here as the subgraph runner passes it: the signal (cancelling the
   * fallback stops the attempt in flight, not only the next one), the registry and
   * resource scope (services and cache checkpoints are the run's, not the global
   * ones), and entitlement enforcement.
   */
  private async executeTaskFallback(
    input: Input,
    signal: AbortSignal
  ): Promise<Output | undefined> {
    const tasks = this.task.subGraph.getTasks();
    if (tasks.length === 0) {
      throw new TaskFailedError("FallbackTask has no alternatives to try");
    }

    const errors: { task: ITask; error: Error }[] = [];
    const totalAttempts = tasks.length;

    for (let i = 0; i < tasks.length; i++) {
      if (signal.aborted) {
        throw new TaskAbortedError("Fallback aborted");
      }

      const alternativeTask = tasks[i];
      const attemptNumber = i + 1;

      await this.handleProgress(
        Math.round(((i + 0.5) / totalAttempts) * 100),
        `Trying alternative ${attemptNumber}/${totalAttempts}: ${alternativeTask.type}`
      );

      try {
        // Reset the task to PENDING so it can be run
        this.resetTask(alternativeTask);

        // Run the individual task with the parent's input, forwarding the
        // stream-pacing options so a streaming/compound alternative inherits
        // the caller's passthrough opt-in, high-water mark, and watchdog.
        const result = await alternativeTask.run(input, {
          signal,
          outputCache: this.outputCache,
          ...this.subGraphRunContext,
          enforceEntitlements: this.task.runConfig?.enforceEntitlements,
          ...this.streamRunOptions,
        });

        await this.handleProgress(
          100,
          `Alternative ${attemptNumber}/${totalAttempts} succeeded: ${alternativeTask.type}`
        );

        return result as Output;
      } catch (error) {
        // Aborts (non-timeout) are not retryable — propagate immediately
        if (error instanceof TaskAbortedError && !(error instanceof TaskTimeoutError)) {
          throw error;
        }
        errors.push({ task: alternativeTask, error: error as Error });
        // Continue to next alternative
      }
    }

    // All alternatives failed
    throw this.buildAggregateError(errors, "task");
  }

  // ========================================================================
  // Data Mode: Run the template workflow with different input overrides
  // ========================================================================

  /**
   * Runs the subgraph workflow multiple times, each time with a different
   * set of input overrides merged from `config.alternatives`.
   */
  private async executeDataFallback(
    input: Input,
    signal: AbortSignal
  ): Promise<Output | undefined> {
    const alternatives = this.task.alternatives;
    if (alternatives.length === 0) {
      throw new TaskFailedError("FallbackTask has no data alternatives to try");
    }

    const errors: { alternative: Record<string, unknown>; error: Error }[] = [];
    const totalAttempts = alternatives.length;

    /**
     * Blend the subgraph's aggregate `graph_progress` with the outer attempt index so
     * nested streaming tasks visibly advance the bar between attempt boundaries. This
     * mirrors the pattern used by {@link IteratorTaskRunner.executeSubgraphIteration}
     * and {@link WhileTask.execute}. Because each attempt resets the subgraph and
     * `graph_progress` starts at 0, the blended value is monotonic across attempts
     * as `currentAttemptIndex` advances.
     */
    let currentAttemptIndex = 0;
    const onSubgraphProgress = (innerProgress: number | undefined, message?: string): void => {
      if (innerProgress === undefined) return;
      const blended = Math.round(
        ((currentAttemptIndex + innerProgress / 100) / totalAttempts) * 100
      );
      void this.handleProgress(
        blended,
        message ?? `Data alternative ${currentAttemptIndex + 1}/${totalAttempts}`
      );
    };
    const unsubscribeSubgraphProgress = this.task.subGraph.subscribe(
      "graph_progress",
      onSubgraphProgress
    );

    // Bubble inner-task events up so subgraph children of a Fallback group
    // surface on the top-level stream (previews + progress). The same subGraph
    // instance is re-run per alternative, so bridge once and tear down in finally.
    const parentGraph = this.task.parentGraph;
    const unbridge = parentGraph
      ? bridgeSubGraphTaskEvents(this.task.subGraph, parentGraph)
      : () => {};

    try {
      for (let i = 0; i < alternatives.length; i++) {
        if (signal.aborted) {
          throw new TaskAbortedError("Fallback aborted");
        }

        currentAttemptIndex = i;
        const alternative = alternatives[i];
        const attemptNumber = i + 1;

        await this.handleProgress(
          Math.round(((i + 0.5) / totalAttempts) * 100),
          `Trying data alternative ${attemptNumber}/${totalAttempts}`
        );

        try {
          // Reset all tasks in the subgraph to PENDING
          this.resetSubgraph();

          // Merge the alternative's data with the original input
          const mergedInput = { ...input, ...alternative } as Input;

          // Run the subgraph with merged input
          // The same run-scoped state GraphAsTaskRunner hands its subgraph.
          const results = await this.task.subGraph.run<Output>(mergedInput, {
            parentSignal: signal,
            outputCache: this.outputCache,
            ...this.subGraphRunContext,
            enforceEntitlements: this.task.runConfig?.enforceEntitlements,
            ...this.streamRunOptions,
          });

          const mergedOutput = this.task.subGraph.mergeExecuteOutputsToRunOutput(
            results,
            this.task.compoundMerge
          ) as Output;

          await this.handleProgress(
            100,
            `Data alternative ${attemptNumber}/${totalAttempts} succeeded`
          );

          return mergedOutput as Output;
        } catch (error) {
          // Aborts (non-timeout) are not retryable — propagate immediately
          if (error instanceof TaskAbortedError && !(error instanceof TaskTimeoutError)) {
            throw error;
          }
          errors.push({ alternative, error: error as Error });
          // Continue to next alternative
        }
      }
    } finally {
      unsubscribeSubgraphProgress();
      unbridge();
    }

    // All alternatives failed
    throw this.buildAggregateError(errors, "data");
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * Resets a single task to PENDING status so it can be re-run.
   */
  private resetTask(task: ITask): void {
    task.status = TaskStatus.PENDING;
    task.progress = 0;
    task.error = undefined;
    task.completedAt = undefined;
    task.startedAt = undefined;
    task.resetInputData();
  }

  /**
   * Resets all tasks and dataflows in the subgraph for a fresh run.
   */
  private resetSubgraph(): void {
    for (const task of this.task.subGraph.getTasks()) {
      this.resetTask(task);
    }
    for (const dataflow of this.task.subGraph.getDataflows()) {
      dataflow.reset();
    }
  }

  /**
   * Builds a descriptive error from all collected failures.
   */
  private buildAggregateError(
    errors: { error: Error; [key: string]: unknown }[],
    mode: "task" | "data"
  ): TaskFailedError {
    const label = mode === "task" ? "alternative" : "data alternative";
    const details = errors
      .map((e, i) => {
        const prefix = e.error instanceof TaskTimeoutError ? "[timeout] " : "";
        return `  ${label} ${i + 1}: ${prefix}${e.error.message}`;
      })
      .join("\n");
    return new TaskFailedError(`All ${errors.length} ${label}s failed:\n${details}`);
  }
}
