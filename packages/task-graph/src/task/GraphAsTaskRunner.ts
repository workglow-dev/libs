/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util";
import { bridgeSubGraphTaskEvents } from "../task-graph/SubGraphEventBridge";
import type { TaskGraph } from "../task-graph/TaskGraph";
import { taskGraphThreadPortabilityError } from "../task-graph/ThreadPortability";
import type { GraphResultArray } from "../task-graph/TaskGraphRunner";
import type { GraphAsTask, GraphAsTaskConfig } from "./GraphAsTask";
import type { ISubGraphDispatcher, SubGraphRunOptionsData } from "./SubGraphDispatch";
import { SUBGRAPH_DISPATCHER } from "./SubGraphDispatch";
import type { TaskRunContext } from "./TaskRunContext";
import { TaskRunner } from "./TaskRunner";
import type { TaskInput, TaskOutput } from "./TaskTypes";

export class GraphAsTaskRunner<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends GraphAsTaskConfig<Input> = GraphAsTaskConfig<Input>,
> extends TaskRunner<Input, Output, Config> {
  declare task: GraphAsTask<Input, Output, Config>;

  /**
   * Protected method to execute a task subgraph by delegating back to the task itself.
   */
  protected async executeTaskChildren(input: Input): Promise<GraphResultArray<Output>> {
    // Route inner graph_progress through handleProgress so the outer graph's
    // updateProgress callback fires (updating task.progress and re-emitting
    // graph_progress up the chain). A bare emit on the task was silently
    // dropped by the outer TaskGraphRunner, leaving parent progress stuck at
    // the value from whichever task ran before this one. Mirrors the pattern
    // used by FallbackTaskRunner, IteratorTaskRunner, and WhileTask.
    const unsubscribe = this.task.subGraph!.subscribe(
      "graph_progress",
      (progress: number | undefined, message?: string, ...args: any[]) => {
        void this.handleProgress(progress, message, ...args);
      }
    );

    // Bubble inner-task events up to the parent graph so subgraph children
    // surface as individual task events on the top-level stream (used for
    // previews and progress colors). Bubbles recursively: a nested compound
    // task forwards its own subgraph to us, and we forward it onward.
    const parent = this.task.parentGraph;
    const unbridge = parent ? bridgeSubGraphTaskEvents(this.task.subGraph!, parent) : () => {};

    try {
      // Off-thread when asked for and possible; the subgraph is serialized once
      // and rebuilt on the far side. Events bridged above stay local to this
      // thread in that case — see the streaming path for what does cross.
      const dispatcher = this.threadDispatcherFor(this.task.subGraph!, this.task.executionMode);
      if (dispatcher !== undefined) {
        return (await dispatcher.runSubGraph(
          {
            graph: this.task.subGraph!.toJSON(),
            input,
            runOptions: this.serializableRunOptions(),
          },
          {
            signal: this.currentCtx?.abortController.signal,
            onProgress: (progress, message) => {
              void this.handleProgress(progress, message);
            },
          }
        )) as GraphResultArray<Output>;
      }

      return await this.task.subGraph!.run<Output>(input, {
        parentSignal: this.currentCtx?.abortController.signal,
        outputCache: this.outputCache,
        // Same accessor `GraphAsTask.executeStream` reads, so the streaming and
        // non-streaming paths cannot hand a subgraph different run-scoped state.
        ...this.subGraphRunContext,
        enforceEntitlements: this.task.runConfig?.enforceEntitlements,
        ...this.streamRunOptions,
      });
    } finally {
      // Always tear down — if subGraph.run() rejects (timeout/abort/inner
      // failure) and this task is later re-run on the same instance, leaked
      // subscriptions would double-emit every inner event to the parent.
      unsubscribe();
      unbridge();
    }
  }
  /**
   * Protected method for preview execution delegation
   *
   * For GraphAsTask, we pass the parent's runInputData to the subgraph's runPreview.
   * This ensures that root tasks in the subgraph (like InputTask) receive the
   * parent's input values after resetInputData() is called.
   */
  protected async executeTaskChildrenPreview(): Promise<GraphResultArray<Output>> {
    return this.task.subGraph!.runPreview<Output>(this.task.runInputData, {
      registry: this.registry,
      resourceScope: this.resourceScope,
    });
  }

  protected override async handleDisable(ctx: TaskRunContext | undefined): Promise<void> {
    if (this.task.hasChildren()) {
      await this.task.subGraph!.disable();
    }
    await super.handleDisable(ctx);
  }

  // ========================================================================
  // TaskRunner method overrides and helpers
  // ========================================================================

  /**
   * Execute the task
   */
  protected override async executeTask(
    input: Input,
    ctx: TaskRunContext
  ): Promise<Output | undefined> {
    if (this.task.hasChildren()) {
      const runExecuteOutputData = await this.executeTaskChildren(input);
      this.task.runOutputData = this.task.subGraph.mergeExecuteOutputsToRunOutput(
        runExecuteOutputData,
        this.task.compoundMerge
      );
    } else {
      const result = await super.executeTask(input, ctx);
      this.task.runOutputData = result ?? ({} as Output);
    }
    return this.task.runOutputData as Output;
  }

  /**
   * Execute the task in preview mode
   */
  public override async executeTaskPreview(
    input: Input,
    ctx: TaskRunContext
  ): Promise<Output | undefined> {
    if (this.task.hasChildren()) {
      const previewResults = await this.executeTaskChildrenPreview();
      this.task.runOutputData = this.task.subGraph.mergeExecuteOutputsToRunOutput(
        previewResults,
        this.task.compoundMerge
      );
      return this.task.runOutputData as Output;
    } else {
      const previewResult = await super.executeTaskPreview(input, ctx);
      if (previewResult !== undefined) {
        this.task.runOutputData = previewResult;
      }
      return this.task.runOutputData as Output;
    }
  }

  /**
   * The dispatcher a subgraph should use to leave this thread, or `undefined`
   * to run in-process.
   *
   * Three things must hold, and each failure is a fallback rather than an
   * error: asking to run off-thread is asking for an optimization, and a graph
   * must produce the same result on a host that cannot honor it. Each reason
   * is logged rather than swallowed, because "my threaded work is not using
   * cores" is otherwise invisible — the run simply stays slow.
   *
   * Lives here rather than on the iterator runner so both compound shapes ask
   * the question the same way; `mode` is whichever flag that subclass reads.
   */
  /**
   * Like {@link threadDispatcherFor}, but also requires the dispatcher to
   * implement streaming. A dispatcher without `runSubGraphStream` would have to
   * buffer the whole subgraph output and hand it over at the end, which is the
   * opposite of what a streaming port is for — so the run stays in-process,
   * where the stream is real.
   *
   * Public because `GraphAsTask.executeStream` is on the task, not the runner.
   */
  public threadStreamDispatcherFor(
    graph: TaskGraph,
    mode: "inline" | "thread"
  ): ISubGraphDispatcher | undefined {
    const dispatcher = this.threadDispatcherFor(graph, mode);
    if (dispatcher === undefined) return undefined;
    if (typeof dispatcher.runSubGraphStream !== "function") {
      getLogger().debug(
        `${this.task.type}: dispatcher cannot stream, running in-process so the subgraph's streaming ports stay live`,
        { taskId: this.task.id }
      );
      return undefined;
    }
    return dispatcher;
  }

  /**
   * The slice of this run's config that can cross a thread as data.
   *
   * Built in one place so the three dispatch sites cannot drift: a subgraph
   * must not run under different semantics merely because it ran elsewhere.
   *
   * Public for the same reason as {@link threadStreamDispatcherFor}:
   * `GraphAsTask.executeStream` is on the task, not the runner.
   */
  public serializableRunOptions(): SubGraphRunOptionsData {
    const { noAccumulation, streamHighWaterBytes, streamGateWatchdogMs } = this.streamRunOptions;
    return {
      enforceEntitlements: this.task.runConfig?.enforceEntitlements,
      noAccumulation,
      streamHighWaterBytes,
      streamGateWatchdogMs,
    };
  }

  protected threadDispatcherFor(
    graph: TaskGraph,
    mode: "inline" | "thread"
  ): ISubGraphDispatcher | undefined {
    if (mode !== "thread") return undefined;

    const dispatcher = this.registry?.has(SUBGRAPH_DISPATCHER)
      ? this.registry.get(SUBGRAPH_DISPATCHER)
      : undefined;
    if (dispatcher === undefined) {
      getLogger().debug(
        `${this.task.type}: off-thread execution requested but no SUBGRAPH_DISPATCHER is registered — running in-process`,
        { taskId: this.task.id }
      );
      return undefined;
    }

    // Checked against the registry the *dispatcher* rebuilds through, not this
    // one: a worker routinely binds a fuller TASK_CONSTRUCTORS map than the
    // host CLI exposes, and asking the wrong map would refuse a graph the far
    // side could have rebuilt perfectly well.
    const reason = taskGraphThreadPortabilityError(graph, this.registry);
    if (reason !== undefined) {
      getLogger().warn(
        `${this.task.type}: subgraph is not thread-portable, running in-process — ${reason}`,
        { taskId: this.task.id }
      );
      return undefined;
    }

    return dispatcher;
  }
}
