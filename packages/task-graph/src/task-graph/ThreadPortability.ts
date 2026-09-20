/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServiceRegistry } from "@workglow/util";
import type { ITask } from "../task/ITask";
import { getTaskConstructors } from "../task/TaskRegistry";
import type { TaskGraph } from "./TaskGraph";

/**
 * Ceiling on nested-subgraph recursion, for the same reason
 * {@link taskGraphJsonShapeError} has one: a cyclic or pathologically deep
 * subgraph chain must come back as a sentence rather than as the stack
 * overflow this function promised to replace.
 */
const MAX_SUBGRAPH_DEPTH = 32;

/**
 * Whether this graph can be rebuilt on another thread, and if not, why.
 *
 * A graph crosses a thread boundary as JSON and is rebuilt from the registry
 * on the far side — there is no way to send a live object. Two things have to
 * hold for every task, including inside nested subgraphs:
 *
 * 1. **It serializes.** `Task.originalConfig` is a `structuredClone` of the
 *    config taken at construction, and is left undefined when that clone
 *    throws; `canSerializeConfig()` is the task's own declaration on top of
 *    that. Either one failing means `toJSON` throws, so the task cannot be
 *    described to the far side at all. A `LambdaTask` (config holds `execute`)
 *    is the pure case; `WhileTask` and `ConditionalTask` are conditional on
 *    whether their condition was given as a function or as declarative config.
 *
 * 2. **Its type is registered.** Serializing says nothing about whether the
 *    far side can rebuild it: `createGraphFromGraphJSON` resolves `type`
 *    through the task-constructor registry, so a type this process knows only
 *    because it declared the class inline is a failure that would otherwise
 *    surface inside the worker, one message hop away from the code that caused
 *    it. Pass the registry the *worker* will use when it differs from this
 *    one.
 *
 * Returns the first problem as a sentence naming the offending task, or
 * `undefined` when the graph is portable. Deliberately a reason rather than a
 * throw: the caller is choosing between a threaded lane and the in-process one,
 * and "why not" is the thing it has to be able to report.
 *
 * @remarks Says nothing about whether running the graph elsewhere is a good
 * idea — a portable graph whose tasks fetch over a rate-limited host is
 * portable and still belongs on the thread that owns the limiter.
 */
export function taskGraphThreadPortabilityError(
  graph: TaskGraph,
  registry?: ServiceRegistry
): string | undefined {
  return portabilityError(graph, getTaskConstructors(registry), 0);
}

function portabilityError(
  graph: TaskGraph,
  constructors: ReadonlyMap<string, unknown>,
  depth: number
): string | undefined {
  if (depth > MAX_SUBGRAPH_DEPTH) return `subgraphs nest deeper than ${MAX_SUBGRAPH_DEPTH}`;

  for (const task of graph.getTasks()) {
    const reason = taskPortabilityError(task, constructors);
    if (reason !== undefined) return reason;

    // `hasChildren` rather than reading `subGraph`: the getter materializes an
    // empty graph on access, so asking directly would give every plain task a
    // subgraph and walk one useless level per node.
    if (task.hasChildren()) {
      const nested = portabilityError(task.subGraph, constructors, depth + 1);
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}

function taskPortabilityError(
  task: ITask,
  constructors: ReadonlyMap<string, unknown>
): string | undefined {
  const name = describeTask(task);

  if (!constructors.has(task.type)) {
    return `${name} has type "${task.type}", which is not a registered task type — the receiving thread could not rebuild it`;
  }

  // Ask the task, then confirm by serializing. `canSerializeConfig()` is a
  // declaration a subclass can get wrong in either direction, and the clone
  // that `originalConfig` holds is the fact underneath it; a task that says
  // yes and then throws would otherwise fail on the dispatch instead of here.
  //
  // Read structurally rather than off `ITask`: the method is part of the
  // serialization contract but `ITaskSerialization` declares only `toJSON` and
  // `toDependencyJSON`, and widening a published interface is not this
  // function's business. Same dodge `RunScheduler.isConditionalTask` uses.
  // A task that does not declare it inherits `Task`'s `true`, so its absence
  // is not a problem — `toJSON()` below is the fact either way.
  try {
    if (declaresConfigUnserializable(task)) {
      return `${name} declares its config unserializable (canSerializeConfig() is false) — config holding a function cannot cross a thread`;
    }
    task.toJSON();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${name} cannot be serialized: ${message}`;
  }

  return undefined;
}

/**
 * Whether the task says its own config cannot be serialized. See the call site
 * for why this is read structurally instead of through `ITask`.
 */
function declaresConfigUnserializable(task: ITask): boolean {
  const declared = (task as { canSerializeConfig?: () => boolean }).canSerializeConfig;
  return typeof declared === "function" && !declared.call(task);
}

/** How a task is named in a reason, preferring whatever identifies it to a reader. */
function describeTask(task: ITask): string {
  const id = typeof task.config?.id === "string" ? task.config.id : undefined;
  return id === undefined ? `task of type "${task.type}"` : `task "${id}"`;
}

export type ThreadPortabilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** {@link taskGraphThreadPortabilityError} as a narrowing result. */
export function validateThreadPortability(
  graph: TaskGraph,
  registry?: ServiceRegistry
): ThreadPortabilityResult {
  const reason = taskGraphThreadPortabilityError(graph, registry);
  return reason === undefined ? { ok: true } : { ok: false, reason };
}
