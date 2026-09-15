/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import "@workglow/a2a/tasks";
import { registerAiTasks } from "@workglow/ai";
import { registerBaseTasks, registerBuiltInTransforms } from "@workglow/task-graph";
import { registerCommonTasks } from "@workglow/tasks";

/**
 * Fills the ambient `TaskRegistry` with the surface the CLI resolves type names
 * against — `task list`, `task run`, the web console, and every stored workflow
 * loaded back from the repository.
 *
 * The filesystem tasks are part of it. This binary runs graphs its own operator
 * wrote, on that operator's machine and with that operator's rights, and a
 * saved workflow naming `FileLoaderTask` has to keep loading. An embedder that
 * runs graphs it did not author registers a narrower set instead of calling
 * this.
 *
 * `@workglow/a2a/tasks` registers on import, which is why it is imported here
 * rather than called: a remote A2A agent is a node a saved workflow can name.
 *
 * Its own module rather than a few lines inside the boot sequence so the set is
 * assertable without standing up a program, a config directory and a model
 * repository.
 */
export function registerCliTasks(): void {
  registerBaseTasks();
  registerCommonTasks({ fileSystemTasks: true });
  registerAiTasks();
  registerBuiltInTransforms();
}
