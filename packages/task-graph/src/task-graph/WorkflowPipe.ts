/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GraphAsTask } from "../task/GraphAsTask";
import type { ITask } from "../task/ITask";
import type { DataPorts } from "../task/TaskTypes";
import type { PipeFunction, Taskish } from "./Conversions";
import { ensureTask } from "./Conversions";
import { Dataflow, DATAFLOW_ALL_PORTS } from "./Dataflow";
import type { ITaskGraph } from "./ITaskGraph";
import type { IWorkflow } from "./IWorkflow";
import type { CompoundMergeStrategy } from "./TaskGraphRunner";
import { PROPERTY_ARRAY } from "./TaskGraphRunner";
import { Workflow } from "./Workflow";

// ============================================================================
// Standalone utility functions (moved from Conversions.ts to break circular
// dependency — these need both Workflow and GraphAsTask which live here)
// ============================================================================

/**
 * @internal
 */
export function getLastTask(workflow: IWorkflow): ITask<any, any, any> | undefined {
  const tasks = workflow.graph.getTasks();
  return tasks.length > 0 ? tasks[tasks.length - 1] : undefined;
}

/**
 * @internal
 */
export function connect(
  source: ITask<any, any, any>,
  target: ITask<any, any, any>,
  workflow: IWorkflow<any, any>
): void {
  workflow.graph.addDataflow(
    new Dataflow(source.id, DATAFLOW_ALL_PORTS, target.id, DATAFLOW_ALL_PORTS)
  );
}

export function pipe<A extends DataPorts, B extends DataPorts>(
  [fn1]: [Taskish<A, B>],
  workflow?: IWorkflow<A, B>
): IWorkflow<A, B>;

export function pipe<A extends DataPorts, B extends DataPorts, C extends DataPorts>(
  [fn1, fn2]: [Taskish<A, B>, Taskish<B, C>],
  workflow?: IWorkflow<A, C>
): IWorkflow<A, C>;

export function pipe<
  A extends DataPorts,
  B extends DataPorts,
  C extends DataPorts,
  D extends DataPorts,
>(
  [fn1, fn2, fn3]: [Taskish<A, B>, Taskish<B, C>, Taskish<C, D>],
  workflow?: IWorkflow<A, D>
): IWorkflow<A, D>;

export function pipe<
  A extends DataPorts,
  B extends DataPorts,
  C extends DataPorts,
  D extends DataPorts,
  E extends DataPorts,
>(
  [fn1, fn2, fn3, fn4]: [Taskish<A, B>, Taskish<B, C>, Taskish<C, D>, Taskish<D, E>],
  workflow?: IWorkflow<A, E>
): IWorkflow<A, E>;

export function pipe<
  A extends DataPorts,
  B extends DataPorts,
  C extends DataPorts,
  D extends DataPorts,
  E extends DataPorts,
  F extends DataPorts,
>(
  [fn1, fn2, fn3, fn4, fn5]: [
    Taskish<A, B>,
    Taskish<B, C>,
    Taskish<C, D>,
    Taskish<D, E>,
    Taskish<E, F>,
  ],
  workflow?: IWorkflow<A, F>
): IWorkflow<A, F>;

export function pipe<I extends DataPorts, O extends DataPorts>(
  args: Taskish<I, O>[],
  workflow: IWorkflow<I, O> = new Workflow<I, O>()
): IWorkflow<I, O> {
  let previousTask = getLastTask(workflow);
  const tasks = args.map((arg) => ensureTask(arg));
  tasks.forEach((task) => {
    workflow.graph.addTask(task);
    if (previousTask) {
      connect(previousTask, task, workflow);
    }
    previousTask = task;
  });
  return workflow;
}

export function parallel<I extends DataPorts = DataPorts, O extends DataPorts = DataPorts>(
  args: (PipeFunction<I, O> | ITask<I, O> | IWorkflow<I, O> | ITaskGraph)[],
  mergeFn: CompoundMergeStrategy = PROPERTY_ARRAY,
  workflow: IWorkflow<I, O> = new Workflow<I, O>()
): IWorkflow<I, O> {
  let previousTask = getLastTask(workflow);
  const tasks = args.map((arg) => ensureTask(arg));
  const config = {
    compoundMerge: mergeFn,
  };
  // Named for what each branch is: a function step is `𝑓 name`, a task or
  // workflow its own type.
  const name = `‖${tasks.map((task) => task.type).join("‖")}‖`;
  class ParallelTask extends GraphAsTask<I, O> {
    public static override type = name;
    /** Minted per call and registered nowhere, so its JSON could never load. */
    public override canSerializeConfig(): boolean {
      return false;
    }
  }
  const mergeTask = new ParallelTask(config);
  mergeTask.subGraph!.addTasks(tasks);
  workflow.graph.addTask(mergeTask);
  if (previousTask) {
    connect(previousTask, mergeTask, workflow);
  }
  return workflow;
}
