/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

import { TaskRegistry } from "@workglow/task-graph";
import { A2UISurfaceTask } from "./A2UISurfaceTask";

export * from "./A2UIConnector";
export * from "./A2UISurfaceTask";

TaskRegistry.registerTask(A2UISurfaceTask);
