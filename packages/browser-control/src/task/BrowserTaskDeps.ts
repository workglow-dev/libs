/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskConfigurationError } from "@workglow/task-graph";
import { createServiceToken, globalServiceRegistry } from "@workglow/util";
import type { BrowserBackendType, BrowserConnectOptions, IBrowserContext } from "./IBrowserContext";

export interface IBrowserProfileStorage {
  save(projectId: string, profileName: string, state: string): Promise<void>;
  load(projectId: string, profileName: string): Promise<string | null>;
  delete(projectId: string, profileName: string): Promise<void>;
}

export interface BrowserTaskDeps {
  readonly createContext: (options: BrowserConnectOptions) => IBrowserContext;
  readonly availableBackends: readonly BrowserBackendType[];
  readonly defaultBackend: BrowserBackendType;
  readonly profileStorage: IBrowserProfileStorage;
}

export const BROWSER_CONTROL_TASK_DEPS = createServiceToken<BrowserTaskDeps>(
  "@workglow/browser-control"
);

export function registerBrowserDeps(deps: BrowserTaskDeps): void {
  globalServiceRegistry.registerInstance(BROWSER_CONTROL_TASK_DEPS, deps);
}

export function getBrowserDeps(): BrowserTaskDeps {
  if (!globalServiceRegistry.has(BROWSER_CONTROL_TASK_DEPS)) {
    throw new TaskConfigurationError(
      "Browser task dependencies not registered. Import @workglow/browser-control/task-server (Node/Bun) or @workglow/browser-control/task-electron before using browser-control tasks."
    );
  }
  return globalServiceRegistry.get(BROWSER_CONTROL_TASK_DEPS);
}
