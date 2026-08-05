/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ILogger } from "@workglow/util";
import {
  Container,
  getLogger,
  globalServiceRegistry,
  ServiceRegistry,
  setLogger,
} from "@workglow/util";
import { registerAllDefaults } from "./registerAllDefaults";

export interface BootstrapOptions {
  /** Logger instance. Replaces the env-driven default. */
  readonly logger?: ILogger;
}

/**
 * Workglow runtime context — an isolated registry plus the well-known accessors
 * needed by application code, tests, and per-tenant orchestration.
 *
 * Returned by `createOrchestrationContext()`. Created internally by
 * `bootstrapWorkglow()` for the global registry.
 */
export interface WorkglowContext {
  readonly registry: ServiceRegistry;
  readonly logger: ILogger;
  /** Releases all instantiated services on this context's registry. */
  dispose(): Promise<void>;
}

/**
 * Bootstraps the global Workglow runtime. Call this once at application
 * startup before invoking any task. Subsequent calls are idempotent.
 *
 * @example
 * ```ts
 * import { bootstrapWorkglow } from "workglow/bootstrap";
 * import { TsLogLogger } from "workglow";
 *
 * bootstrapWorkglow({ logger: new TsLogLogger() });
 * ```
 */
export function bootstrapWorkglow(opts: BootstrapOptions = {}): WorkglowContext {
  registerAllDefaults(globalServiceRegistry);
  if (opts.logger) {
    setLogger(opts.logger, globalServiceRegistry);
  }
  return {
    registry: globalServiceRegistry,
    get logger() {
      return getLogger(globalServiceRegistry);
    },
    async dispose() {
      // The global registry is shared; we don't actually dispose it here.
      // Use `createOrchestrationContext()` for disposable contexts.
    },
  };
}

/**
 * Creates an isolated Workglow runtime context backed by a fresh child
 * container — independent of the global registry. Useful for tests,
 * multi-tenant servers, and embedded use cases that need to dispose all
 * services without touching shared state.
 *
 * @example
 * ```ts
 * const ctx = createOrchestrationContext({ logger: new MyLogger() });
 * try {
 *   await task.run({ ..., context: ctx });
 * } finally {
 *   await ctx.dispose();
 * }
 * ```
 */
export function createOrchestrationContext(opts: BootstrapOptions = {}): WorkglowContext {
  const container = new Container();
  const registry = new ServiceRegistry(container);
  registerAllDefaults(registry);
  if (opts.logger) {
    setLogger(opts.logger, registry);
  }
  return {
    registry,
    get logger() {
      return getLogger(registry);
    },
    async dispose() {
      await registry.dispose();
    },
  };
}
