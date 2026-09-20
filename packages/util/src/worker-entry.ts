/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight entry point for worker contexts.
 *
 * Exports only the DI, logging, worker infrastructure, and parse utilities
 * needed by AI provider workers — without the heavy JSON Schema validation
 * (ajv, URI.js, nearley, json-pointer) that bloats the main barrel export.
 *
 * AI provider packages should import from `@workglow/util/worker` in files
 * that run inside Web Workers / worker threads.
 */

// organize-imports-ignore

export * from "./di";

export * from "./logging";

// Platform-specific WorkerServer registration (Worker.browser/node/bun) is NOT
// included here. The worker registration files must import @workglow/util to trigger
// the side-effect that registers the WorkerServer implementation.
export * from "./worker/BackpressureGate";
export * from "./worker/streamCost";
export * from "./worker/WorkerServerBase";
export * from "./worker/WorkerManager";
export * from "./worker/scrubStack";

export * from "./json-schema/PartialJsonStream";
export * from "./json-schema/parsePartialJson";

export type { DataPortSchemaObject } from "./json-schema/DataPortSchema";
export type { FromSchema } from "./json-schema/FromSchema";
export type { JsonSchema, JsonSchemaCustomProps } from "./json-schema/JsonSchema";

export type { TypedArray } from "./vector/TypedArray";
