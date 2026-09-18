/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask } from "../task/ITask";
import type { Task } from "../task/Task";
import {
  type EntitlementId,
  type TaskEntitlement,
  type TaskEntitlements,
  type TrackedTaskEntitlement,
  type TrackedTaskEntitlements,
  EMPTY_ENTITLEMENTS,
  mergeEntitlementPair,
} from "../task/TaskEntitlements";
import type { TaskIdType } from "../task/TaskTypes";
import { TaskStatus } from "../task/TaskTypes";
import { DATAFLOW_ALL_PORTS } from "./Dataflow";
import type { TaskGraph } from "./TaskGraph";

// ========================================================================
// Options
// ========================================================================

export interface GraphEntitlementOptions {
  /**
   * When true, annotate each entitlement with the source task IDs that require it.
   */
  readonly trackOrigins?: boolean;
  /**
   * Controls which ConditionalTask branches are included.
   * - "all" (default): Include entitlements from ALL branches (conservative, pre-execution analysis)
   * - "active": Only include entitlements from currently active branches (runtime, after conditions evaluated)
   */
  readonly conditionalBranches?: "all" | "active";
}

// ========================================================================
// Graph Entitlement Computation
// ========================================================================

/**
 * Computes the aggregated entitlements for a TaskGraph.
 * Returns the union of all task entitlements in the graph.
 *
 * When `trackOrigins` is true, returns TrackedTaskEntitlements with source task IDs.
 */
export function computeGraphEntitlements(
  graph: TaskGraph,
  options?: GraphEntitlementOptions & { readonly trackOrigins: true }
): TrackedTaskEntitlements;
export function computeGraphEntitlements(
  graph: TaskGraph,
  options?: GraphEntitlementOptions
): TaskEntitlements;
export function computeGraphEntitlements(
  graph: TaskGraph,
  options?: GraphEntitlementOptions
): TaskEntitlements | TrackedTaskEntitlements {
  const tasks = graph.getTasks();
  if (tasks.length === 0) return EMPTY_ENTITLEMENTS;

  const trackOrigins = options?.trackOrigins ?? false;
  const conditionalBranches = options?.conditionalBranches ?? "all";

  // Accumulate entitlements by ID
  const merged = new Map<
    EntitlementId,
    { entitlement: TaskEntitlement; sourceTaskIds: TaskIdType[] }
  >();

  for (const task of tasks) {
    // For ConditionalTask with "active" mode, skip disabled tasks
    if (conditionalBranches === "active" && task.status !== undefined) {
      if (task.status === TaskStatus.DISABLED) continue;
    }

    const taskEntitlements = task.entitlements();
    for (const entitlement of taskEntitlements.entitlements) {
      const existing = merged.get(entitlement.id);
      if (existing) {
        // Merge: optional=false wins, resources are unioned
        existing.entitlement = mergeEntitlementPair(existing.entitlement, entitlement);
        if (trackOrigins) {
          existing.sourceTaskIds.push(task.id);
        }
      } else {
        merged.set(entitlement.id, {
          entitlement,
          sourceTaskIds: trackOrigins ? [task.id] : [],
        });
      }
    }
  }

  if (merged.size === 0) return EMPTY_ENTITLEMENTS;

  if (trackOrigins) {
    const entitlements: TrackedTaskEntitlement[] = [];
    for (const { entitlement, sourceTaskIds } of merged.values()) {
      entitlements.push({ ...entitlement, sourceTaskIds });
    }
    return { entitlements };
  }

  return { entitlements: Array.from(merged.values()).map((e) => e.entitlement) };
}

// ========================================================================
// Static Input Projection
// ========================================================================

/**
 * The input a task is already known to receive: whatever has been seeded onto
 * it, backfilled with its schema defaults. Mirrors `Task.setInput`'s
 * precedence — an explicit value beats a declared default — so this is what
 * the task would really see, not an approximation of it.
 *
 * Exported because a compound task declaring its own entitlements needs the
 * same view of its input to project into its subgraph — see
 * `GraphAsTask.entitlements()`.
 */
export function knownInput(task: ITask): Record<string, unknown> {
  const known: Record<string, unknown> = { ...task.runInputData };
  const schema = task.inputSchema();
  if (typeof schema === "boolean") return known;
  for (const [port, property] of Object.entries(schema.properties ?? {})) {
    if (known[port] !== undefined) continue;
    const fallback = (property as { default?: unknown }).default;
    if (fallback !== undefined) known[port] = fallback;
  }
  return known;
}

/**
 * Seeds each task's `runInputData` with the inputs it is already known to
 * receive, runs `fn`, then puts every touched task back exactly as it was.
 *
 * Pre-flight entitlement evaluation runs once before any task executes, so a
 * task whose declaration depends on its input — `FetchUrlTask` classifying its
 * `url` — sees nothing when that input arrives over a dataflow, and declares
 * the fail-closed superset instead (an unscoped `network:private` covering
 * every private destination). That is correct but unusable: it denies a public
 * URL as readily as a private one, and no grant short of "all private hosts"
 * satisfies it.
 *
 * Only two things are treated as known: the run input handed to root tasks,
 * and the input of a task that declares `passthroughInputsToOutputs` — whose
 * output *is* its input, by that declaration. Everything a task computes stays
 * unknown, so a URL produced by a script node still declares fail-closed. The
 * projection narrows declarations where the value is already settled and
 * changes nothing where it is not.
 *
 * The projection is strictly an evaluation-time view. `fn` must be
 * synchronous, and the restore in `finally` runs before the run loop starts,
 * so no task ever executes against a seeded value — a dataflow that fails to
 * deliver still fails, rather than silently falling back to what was projected
 * here.
 */
export function withStaticInputProjection<T>(
  graph: TaskGraph,
  runInput: Readonly<Record<string, unknown>> | undefined,
  fn: () => T
): T {
  const restore: { task: ITask; data: Record<string, any> }[] = [];

  const seed = (task: ITask, values: Readonly<Record<string, unknown>>): void => {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    restore.push({ task, data: task.runInputData });
    task.runInputData = { ...task.runInputData };
    for (const [port, value] of entries) {
      task.runInputData[port] = value;
    }
  };

  const project = (
    target: TaskGraph,
    input: Readonly<Record<string, unknown>> | undefined
  ): void => {
    const tasks = target.topologicallySortedNodes();

    // Root tasks receive the run input, matching how the scheduler seeds them.
    if (input !== undefined) {
      for (const task of tasks) {
        if (target.getSourceDataflows(task.id).length === 0) seed(task, input);
      }
    }

    for (const task of tasks) {
      // Nested first: a compound task's declaration aggregates its subgraph, so
      // the subgraph has to be projected before that aggregate is read. Its
      // roots take the compound task's own (already seeded) input, mirroring
      // how `GraphAsTaskRunner` hands its input to `subGraph.run`.
      if (task.hasChildren()) project(task.subGraph, knownInput(task));

      if ((task.constructor as typeof Task).passthroughInputsToOutputs !== true) continue;
      const outputs = knownInput(task);

      for (const dataflow of target.getTargetDataflows(task.id)) {
        const downstream = target.getTask(dataflow.targetTaskId);
        if (!downstream) continue;
        if (dataflow.sourceTaskPortId === DATAFLOW_ALL_PORTS) {
          seed(
            downstream,
            dataflow.targetTaskPortId === DATAFLOW_ALL_PORTS
              ? outputs
              : { [dataflow.targetTaskPortId]: outputs }
          );
          continue;
        }
        // `*` on the target side takes the whole upstream output; a named port
        // takes just that value. An absent port seeds nothing, which leaves the
        // downstream declaration fail-closed — the same as no projection.
        const value = outputs[dataflow.sourceTaskPortId];
        if (value === undefined) continue;
        seed(
          downstream,
          dataflow.targetTaskPortId === DATAFLOW_ALL_PORTS
            ? (value as Record<string, unknown>)
            : { [dataflow.targetTaskPortId]: value }
        );
      }
    }
  };

  try {
    project(graph, runInput);
    return fn();
  } finally {
    // Reverse order so a task seeded more than once returns to its original
    // object, not to an intermediate copy.
    for (let i = restore.length - 1; i >= 0; i--) {
      restore[i]!.task.runInputData = restore[i]!.data;
    }
  }
}
