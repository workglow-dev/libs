/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid4 } from "@workglow/util";
import { Dataflow } from "../task-graph/Dataflow";
import { bridgeSubGraphTaskEvents } from "../task-graph/SubGraphEventBridge";
import { TaskGraph } from "../task-graph/TaskGraph";
import { GraphAsTaskRunner } from "./GraphAsTaskRunner";
import type { ITaskConstructor } from "./ITask";
import {
  resolveIterationBound,
  type IterationAnalysisResult,
  type IteratorTask,
  type IteratorTaskConfig,
} from "./IteratorTask";
import { TaskAbortedError } from "./TaskError";
import type { TaskRunContext } from "./TaskRunContext";
import type { TaskInput, TaskOutput } from "./TaskTypes";

/**
 * Runner for IteratorTask that executes a single subgraph repeatedly with
 * per-iteration inputs. The task defines iteration analysis/collection hooks,
 * while this runner owns scheduling and execution orchestration.
 */
export class IteratorTaskRunner<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends IteratorTaskConfig<Input> = IteratorTaskConfig<Input>,
> extends GraphAsTaskRunner<Input, Output, Config> {
  declare task: IteratorTask<Input, Output, Config>;

  /** When true, {@link executeSubgraphIteration} folds inner progress into parent MapTask %. */
  private aggregatingParentMapProgress = false;
  private mapPartialProgress: number[] = [];
  private mapPartialIterationCount = 0;
  /**
   * The sum of {@link mapPartialProgress} and how many of its entries are at 100, kept as the
   * entries change: every iteration reports progress several times, so recomputing them from
   * the array made each report cost the iteration count and a map of N iterations cost N².
   */
  private mapPartialSum = 0;
  private mapPartialDone = 0;

  /**
   * For iterator tasks, runPreview() invokes only the task's executePreview hook —
   * it does not iterate the subgraph.
   */

  protected override async executeTask(
    input: Input,
    _ctx: TaskRunContext
  ): Promise<Output | undefined> {
    let analysis = this.task.analyzeIterationInput(input);

    // Enforce maxIterations cap. Config is required (construction-time guard),
    // so the bound is always set; `"unbounded"` resolves to Infinity, which
    // leaves the natural array-length count untouched.
    const maxIterations = resolveIterationBound(this.task.config.maxIterations);
    if (analysis.iterationCount > maxIterations) {
      analysis = { ...analysis, iterationCount: maxIterations };
    }

    if (analysis.iterationCount === 0) {
      return this.task.getEmptyResult() as Output;
    }

    const result = this.task.isReduceTask()
      ? await this.executeReduceIterations(analysis)
      : await this.executeCollectIterations(analysis);

    return result as Output;
  }

  /**
   * Iterator tasks should only run the task's preview hook here.
   */
  public override async executeTaskPreview(
    input: Input,
    _ctx: TaskRunContext
  ): Promise<Output | undefined> {
    return this.task.executePreview?.(input, { own: this.own });
  }

  protected async executeCollectIterations(analysis: IterationAnalysisResult): Promise<Output> {
    const iterationCount = analysis.iterationCount;
    const preserveOrder = this.task.preserveIterationOrder();

    const batchSize =
      this.task.batchSize !== undefined && this.task.batchSize > 0
        ? this.task.batchSize
        : iterationCount;

    const requestedConcurrency = this.task.concurrencyLimit ?? iterationCount;
    const concurrency = Math.max(1, Math.min(requestedConcurrency, iterationCount));

    // A `.forEach()` folds nothing, so nothing is kept: the arrays below would
    // otherwise hold one merged output per item for the whole batch — and with
    // no `batchSize` that is the entire iteration set.
    const retainResults = this.task.retainsIterationResults();
    const orderedResults: Array<TaskOutput | undefined> =
      retainResults && preserveOrder ? new Array(iterationCount) : [];
    const completionOrderResults: TaskOutput[] = [];

    this.task.clearIterationGraphs();
    this.aggregatingParentMapProgress = true;
    this.mapPartialIterationCount = iterationCount;
    this.mapPartialProgress = new Array(iterationCount).fill(0);
    this.mapPartialSum = 0;
    this.mapPartialDone = 0;

    try {
      for (let batchStart = 0; batchStart < iterationCount; batchStart += batchSize) {
        if (this.currentCtx?.abortController.signal.aborted) {
          // Honor cancellation as a failure: returning the partial map result
          // would report a truncated array as a COMPLETED success.
          throw new TaskAbortedError("Iterator aborted during iteration");
        }

        const batchEnd = Math.min(batchStart + batchSize, iterationCount);
        const batchIndices = Array.from(
          { length: batchEnd - batchStart },
          (_, i) => batchStart + i
        );

        const batchResults = await this.executeBatch(
          batchIndices,
          analysis,
          iterationCount,
          concurrency,
          undefined,
          retainResults
        );

        for (const { index, result } of batchResults) {
          if (result === undefined) continue;

          if (preserveOrder) {
            orderedResults[index] = result;
          } else {
            completionOrderResults.push(result);
          }
        }
      }

      const collected = preserveOrder
        ? orderedResults.filter((result): result is TaskOutput => result !== undefined)
        : completionOrderResults;

      return this.task.collectResults(collected);
    } finally {
      this.aggregatingParentMapProgress = false;
    }
  }

  /** Sets one iteration's partial progress, keeping the running sum and done count in step. */
  private setMapPartialProgress(index: number, value: number): void {
    const prior = this.mapPartialProgress[index] ?? 0;
    this.mapPartialProgress[index] = value;
    this.mapPartialSum += value - prior;
    this.mapPartialDone += (value >= 100 ? 1 : 0) - (prior >= 100 ? 1 : 0);
  }

  /**
   * Updates parent MapTask / workflow progress from per-iteration partial completion (0–100 each).
   */
  private emitMapParentProgressFromPartials(
    childMessage?: string,
    activeIterationIndex?: number
  ): void {
    const n = this.mapPartialIterationCount;
    if (n <= 0) return;
    const overall = Math.round(this.mapPartialSum / n);
    const done = this.mapPartialDone;
    const displayIteration =
      activeIterationIndex === undefined ? done : Math.min(activeIterationIndex + 1, n);
    const base = `Map ${displayIteration}/${n}`;
    const msg =
      activeIterationIndex === undefined
        ? `${base} iterations`
        : childMessage
          ? `${base} — ${childMessage}`
          : base;
    void this.handleProgress(overall, msg);
  }

  protected async executeReduceIterations(analysis: IterationAnalysisResult): Promise<Output> {
    this.task.clearIterationGraphs();
    const iterationCount = analysis.iterationCount;
    let accumulator = this.task.getInitialAccumulator();

    for (let index = 0; index < iterationCount; index++) {
      if (this.currentCtx?.abortController.signal.aborted) {
        // Honor cancellation as a failure: returning the partial accumulator
        // would report an incomplete reduction as a COMPLETED success.
        throw new TaskAbortedError("Iterator aborted during iteration");
      }

      const iterationInput = this.task.buildIterationRunInput(analysis, index, iterationCount, {
        accumulator,
      });

      const iterationResult = await this.executeSubgraphIteration(
        iterationInput,
        index,
        iterationCount
      );
      accumulator = this.task.mergeIterationIntoAccumulator(accumulator, iterationResult, index);

      const progress = Math.round(((index + 1) / iterationCount) * 100);
      await this.handleProgress(progress, `Completed ${index + 1}/${iterationCount} iterations`);
    }

    return accumulator;
  }

  protected async executeBatch(
    indices: number[],
    analysis: IterationAnalysisResult,
    iterationCount: number,
    concurrency: number,
    onItemComplete?: () => Promise<void>,
    /** When false, iteration outputs are dropped as they arrive (see {@link IteratorTask.retainsIterationResults}). */
    retainResults: boolean = true
  ): Promise<Array<{ index: number; result: TaskOutput | undefined }>> {
    const results: Array<{ index: number; result: TaskOutput | undefined }> = [];
    let cursor = 0;

    const workerCount = Math.max(1, Math.min(concurrency, indices.length));

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (this.currentCtx?.abortController.signal.aborted) {
          return;
        }

        const position = cursor;
        cursor += 1;

        if (position >= indices.length) {
          return;
        }

        const index = indices[position];
        const iterationInput = this.task.buildIterationRunInput(analysis, index, iterationCount);
        const result = await this.executeSubgraphIteration(iterationInput, index, iterationCount);
        if (retainResults) results.push({ index, result });
        await onItemComplete?.();
      }
    });

    await Promise.all(workers);
    return results;
  }

  /**
   * Clones a TaskGraph by reconstructing each task from its constructor,
   * defaults, and config. This preserves non-serializable config such as
   * function references (e.g. WhileTask condition functions).
   */
  private cloneGraph(graph: TaskGraph): TaskGraph {
    const clone = new TaskGraph();
    const idMap = new Map<unknown, string>();
    for (const task of graph.getTasks()) {
      const ctor = task.constructor as ITaskConstructor<any, any, any>;
      const newId = uuid4();
      idMap.set(task.config.id, newId);
      const clonedConfig = { ...task.config, id: newId };
      const newTask = new ctor({ ...clonedConfig, defaults: task.defaults }, task.runConfig);
      if (task.hasChildren()) {
        newTask.subGraph = this.cloneGraph(task.subGraph);
      }
      clone.addTask(newTask);
    }
    for (const df of graph.getDataflows()) {
      clone.addDataflow(
        new Dataflow(
          idMap.get(df.sourceTaskId) ?? df.sourceTaskId,
          df.sourceTaskPortId,
          idMap.get(df.targetTaskId) ?? df.targetTaskId,
          df.targetTaskPortId
        )
      );
    }
    return clone;
  }

  protected async executeSubgraphIteration(
    input: Record<string, unknown>,
    index: number,
    iterationCount: number
  ): Promise<TaskOutput | undefined> {
    if (this.currentCtx?.abortController.signal.aborted) {
      return undefined;
    }

    const graphClone = this.cloneGraph(this.task.subGraph);
    this.task.trackIterationGraph(index, graphClone);

    this.task.emit("iteration_start", index, iterationCount, graphClone);

    /**
     * Subscribe to the iteration subgraph's aggregate `graph_progress` rather than individual
     * task `progress` events. {@link TaskGraphRunner.handleProgress} already averages across
     * only the tasks whose class declares its own `execute` (see `taskPrototypeHasOwnExecute`),
     * so passthrough nodes like `InputTask` — which hit `progress=100` immediately and would
     * otherwise saturate a max-across-tasks partial — are correctly excluded. This mirrors
     * the pattern in {@link GraphAsTaskRunner.executeTaskChildren}, and the `finally` block
     * below bumps the partial to 100 to guarantee completion for degenerate (all-passthrough)
     * subgraphs where `contributors.length === 0`.
     */
    const onGraphProgress = (p: number | undefined, message?: string): void => {
      this.task.emit("iteration_progress", index, iterationCount, p, message, graphClone);
      if (
        p !== undefined &&
        this.aggregatingParentMapProgress &&
        this.mapPartialIterationCount > 0
      ) {
        this.setMapPartialProgress(index, Math.max(this.mapPartialProgress[index] ?? 0, p));
        this.emitMapParentProgressFromPartials(message, index);
      }
    };
    const unsubscribeGraphProgress = graphClone.subscribe("graph_progress", onGraphProgress);

    // Bubble inner-task events up to the parent graph so subgraph children of an
    // iteration surface as individual task events on the top-level stream
    // (previews + progress), matching GraphAsTask / While / Fallback. A fresh
    // clone is bridged per iteration, so tear down in finally — otherwise each
    // discarded clone leaks its parentGraph subscriptions for the iterator's life.
    const parentGraph = this.task.parentGraph;
    const unbridge = parentGraph ? bridgeSubGraphTaskEvents(graphClone, parentGraph) : () => {};

    try {
      const results = await graphClone.run<TaskOutput>(input as TaskInput, {
        parentSignal: this.currentCtx?.abortController.signal,
        outputCache: this.outputCache,
        registry: this.registry,
        resourceScope: this.resourceScope,
        ...this.streamRunOptions,
      });

      if (results.length === 0) {
        return undefined;
      }

      return graphClone.mergeExecuteOutputsToRunOutput(
        results,
        this.task.compoundMerge
      ) as TaskOutput;
    } finally {
      unsubscribeGraphProgress();
      unbridge();
      if (this.aggregatingParentMapProgress && this.mapPartialIterationCount > 0) {
        this.setMapPartialProgress(index, 100);
        this.emitMapParentProgressFromPartials();
      }
      this.task.completeIterationGraph(index);
      this.task.emit("iteration_complete", index, iterationCount);
    }
  }
}
