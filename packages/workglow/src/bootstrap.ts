/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Explicit bootstrap entry point for the Workglow runtime. Call
 * `bootstrapWorkglow()` once at application startup to install defaults onto
 * the global registry, or `createOrchestrationContext()` for an isolated
 * registry (tests, multi-tenant servers, embedded use).
 *
 * The implementation lives in `@workglow/bootstrap` so workspace packages can
 * install the same defaults without depending on this meta-package.
 */

export * from "@workglow/bootstrap";
