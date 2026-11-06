/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./ConditionalTask";
export * from "./ConditionUtils";
export * from "./EntitlementApproval";
export * from "./EntitlementEnforcer";
export * from "./EntitlementPolicy";
export * from "./EntitlementProfile";
export * from "./EntitlementProfiles";
export * from "./EntitlementResolver";
export * from "./InputCompactor";
export * from "./InputResolver";
export * from "./ITask";
export * from "./iterationSchema";
export * from "./JobQueueFactory";
export * from "./MapTask";
export * from "./ReduceTask";
export * from "./StreamTypes";
export * from "./Task";
// The clone/strip helpers are a standalone seam now, not private Task methods,
// so they are exported rather than reached through `(task as any)`.
export * from "./TaskCloneOps";
export * from "./TaskEntitlements";
export * from "./UrlClassifier";
export * from "./TaskError";
export * from "./TaskEvents";
export * from "./TaskJSON";
export * from "./TaskQueueRegistry";
export * from "./TaskRegistry";
export * from "./TaskTypes";

export * from "./GraphAsTask";
export * from "./GraphAsTaskRunner";

// Side-effecting: registers the pipe-function wrapper factory with Conversions.
// Must be reached whenever `ensureTask` can be, i.e. from this barrel.
import "./PipeFunctionTask";

export * from "./FallbackTask";
export * from "./FallbackTaskRunner";
export * from "./IteratorTask";
export * from "./IteratorTaskRunner";
export * from "./WhileTask";
export * from "./WhileTaskRunner";

import { ConditionalTask } from "./ConditionalTask";
import { FallbackTask } from "./FallbackTask";
import { GraphAsTask } from "./GraphAsTask";
import { MapTask } from "./MapTask";
import { ReduceTask } from "./ReduceTask";
import { TaskRegistry } from "./TaskRegistry";
import { WhileTask } from "./WhileTask";

export const registerBaseTasks = () => {
  const tasks = [GraphAsTask, ConditionalTask, FallbackTask, MapTask, WhileTask, ReduceTask];
  tasks.map(TaskRegistry.registerTask);
  return tasks;
};
