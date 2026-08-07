/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerAiProviderDefaults, registerModelDefaults } from "@workglow/ai";
import { registerKnowledgeBaseDefaults } from "@workglow/knowledge-base";
import { registerMcpServerDefaults } from "@workglow/mcp/util";
import { registerTabularStorageDefaults } from "@workglow/storage";
import { registerTaskDefaults, registerTransformDefaults } from "@workglow/task-graph";
import {
  registerCredentialDefaults,
  registerInputCompactorDefaults,
  registerInputResolverDefaults,
  registerLoggerDefaults,
  registerTelemetryDefaults,
  ServiceRegistry,
} from "@workglow/util";
import { registerImageDefaults } from "@workglow/util/media";
import { registerWorkerManagerDefaults } from "@workglow/util/worker";

/**
 * Registers every default factory and input resolver/compactor from the
 * core Workglow packages onto the given registry.
 *
 * Idempotent — safe to call multiple times. `registerIfAbsent` ensures
 * earlier explicit registrations (e.g. a custom storage backend) are not
 * overwritten.
 *
 * The registry is required, never defaulted: this mutates whichever container
 * it is handed, so the target is always stated at the call site. Pass
 * `globalServiceRegistry` explicitly for process-wide defaults, or
 * prefer `bootstrapWorkglow()` / `createOrchestrationContext()`.
 */
export function registerAllDefaults(registry: ServiceRegistry): void {
  // Primitive containers first — resolvers/compactors are stored in maps
  // registered by these calls.
  registerInputResolverDefaults(registry);
  registerInputCompactorDefaults(registry);
  registerLoggerDefaults(registry);
  registerTelemetryDefaults(registry);
  registerWorkerManagerDefaults(registry);

  // Built-in input resolvers/compactors.
  registerImageDefaults(registry);
  registerCredentialDefaults(registry);
  registerModelDefaults(registry);
  registerAiProviderDefaults(registry);
  registerKnowledgeBaseDefaults(registry);
  registerMcpServerDefaults(registry);
  registerTabularStorageDefaults(registry);
  registerTaskDefaults(registry);
  registerTransformDefaults(registry);
}
