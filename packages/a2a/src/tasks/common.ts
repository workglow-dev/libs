/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

import { TaskRegistry } from "@workglow/task-graph";
import { A2AAgentTask } from "./A2AAgentTask";

export * from "./A2AAgentTask";

TaskRegistry.registerTask(A2AAgentTask);
